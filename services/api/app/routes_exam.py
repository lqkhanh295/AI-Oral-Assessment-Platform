import hashlib
import math
import os
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from . import processing, storage
from . import schemas as s
from .config import settings
from .db import get_db
from .desktop_policy import policy as desktop_policy
from .desktop_policy import session_policy as desktop_session_policy
from .examination import check_schedule, schedule_for
from .grading import GradingError, check_config
from .models import (
    Assignment,
    Attempt,
    Audit,
    Course,
    CourseEnrollment,
    Exam,
    ExamSession,
    ProcessingJob,
    Upload,
)
from .permissions import has_role
from .practice import COURSE_ID
from .retakes import ACTIVE, allowance, sessions_for, submission_history_row, submission_status
from .security import by_id, current_user, exam_access, fail
from .submissions import missing_stt_assessment, stt_skipped_reason
from .worker import finalize

router = APIRouter()


def owned_session(db, key, user, lock=False):
    session = by_id(db, ExamSession, key, lock)
    if session.deleted_at is not None:
        fail(404, "NOT_FOUND", "Lần thi đã bị xóa")
    exam = by_id(db, Exam, session.exam_id)
    if exam.course_id == COURSE_ID or (exam.snapshot or {}).get("practice"):
        fail(410, "PRACTICE_DISABLED", "Chức năng học và thi thử đã ngừng sử dụng")
    if session.student_id != user.id:
        fail(403, "FORBIDDEN", "Phiên thi không thuộc sinh viên")
    return session


def owned_attempt(db, key, user, lock=False):
    attempt = by_id(db, Attempt, key, lock)
    session = owned_session(db, attempt.session_id, user)
    return attempt, session


def active(db, session):
    if session.status != "IN_PROGRESS":
        fail(409, "EXAM_SESSION_NOT_ACTIVE", "Phiên thi không hoạt động")
    exam = by_id(db, Exam, session.exam_id)
    if time.time() > session.started_at + exam.time_limit:
        fail(409, "EXAM_EXPIRED", "Đã hết giờ. Bạn có thể nộp bài để giảng viên xem lại.")


def public_session(db, session):
    exam = by_id(db, Exam, session.exam_id)
    attempts = db.scalars(
        select(Attempt).where(Attempt.session_id == session.id).order_by(Attempt.sequence)
    ).all()
    first = next((a for a in attempts if a.status in {"READY", "STARTED"}), None)
    return {
        "id": session.id,
        "timed_questions": True,
        "server_processing": not bool(exam.snapshot.get("practice")),
        "attempt_number": session.attempt_number,
        "exam_name": exam.name,
        "practice": bool(exam.snapshot.get("practice")),
        "status": submission_status(session.status),
        "started_at": session.started_at,
        "screen_required": session.screen_required,
        "desktop_policy": desktop_session_policy(session),
        "screen_attempt_id": attempts[0].id if attempts else None,
        "time_limit": exam.time_limit,
        "server_time": time.time(),
        "question_count": len(attempts),
        "answered_count": sum(a.status in {"SUBMITTED", "GRADED"} for a in attempts),
        "current_attempt": (
            {
                "id": first.id,
                "sequence": first.sequence,
                "text": first.question["text"],
                "rich_content": first.question.get("rich_content"),
                "prompt_image": first.question.get("prompt_image") if first.question.get("prompt_image") in {
                    "/practice/toeic-speaking/office.svg", "/practice/toeic-speaking/cafe.svg"
                } else None,
                "status": first.status,
                "preparation_seconds": first.question.get("preparation_seconds", 10),
                "recording_seconds": first.question.get("recording_seconds", 60),
            }
            if first and session.status == "IN_PROGRESS"
            else None
        ),
    }


@router.get("/exams/available")
def available(db: Session = Depends(get_db), user=Depends(current_user)):
    exams = db.scalars(
        select(Exam)
        .where(
            Exam.status == "PUBLISHED",
            or_(
                Exam.course_id.in_(
                    select(CourseEnrollment.course_id).where(CourseEnrollment.student_id == user.id)
                ),
                Exam.id.in_(select(Assignment.exam_id).where(Assignment.student_id == user.id)),
            ),
        )
        .order_by(Exam.created_at)
    ).all()
    result = []
    for exam in exams:
        if exam.course_id == COURSE_ID or exam.snapshot.get("practice"):
            continue
        assignment = schedule_for(db, exam, user.id)
        if exam.workflow and (not has_role(user, "STUDENT") or assignment is None):
            continue
        sessions = sessions_for(db, exam.id, user.id)
        session = next((s for s in sessions if s.status in ACTIVE), sessions[0] if sessions else None)
        result.append(
            {
                "id": exam.id,
                "name": exam.name,
                "course_id": exam.course_id,
                "course_name": db.get(Course, exam.course_id).name,
                "practice": bool(exam.snapshot.get("practice")),
                "time_limit": exam.time_limit,
                "question_count": len(exam.snapshot["questions"]),
                "opens_at": assignment.opens_at if assignment else None,
                "closes_at": assignment.closes_at if assignment else None,
                "server_time": time.time(),
                "workflow": exam.workflow,
                "session_id": session.id if session else None,
                "status": submission_status(session.status) if session else "ASSIGNED",
                **allowance(db, exam, user.id, sessions),
                "history": [submission_history_row(s) for s in sessions],
            }
        )
    return result


@router.post("/exam-sessions")
def create_session(body: s.SessionIn, db: Session = Depends(get_db), user=Depends(current_user)):
    exam = by_id(db, Exam, body.exam_id, lock=True)
    if exam.course_id == COURSE_ID or (exam.snapshot or {}).get("practice"):
        fail(410, "PRACTICE_DISABLED", "Chức năng học và thi thử đã ngừng sử dụng")
    allowed = (
        db.scalar(
            select(CourseEnrollment.id).where(
                CourseEnrollment.course_id == exam.course_id, CourseEnrollment.student_id == user.id
            )
        )
        or db.scalar(
            select(Assignment.id).where(Assignment.exam_id == exam.id, Assignment.student_id == user.id)
        )
    )
    if exam.workflow and (not has_role(user, "STUDENT") or not schedule_for(db, exam, user.id)):
        fail(403, "NOT_ASSIGNED", "Bạn không có tên trong danh sách kỳ thi")
    if exam.status != "PUBLISHED" or not allowed:
        fail(403, "NOT_ASSIGNED", "Bạn chưa được giao bài thi này")
    sessions = sessions_for(db, exam.id, user.id)
    existing = next((s for s in sessions if s.status in ACTIVE), None)
    if existing:
        return public_session(db, existing)
    if sessions and not body.new_attempt:
        return public_session(db, sessions[0])
    check_schedule(db, exam, user)
    try:
        check_config(exam)
    except GradingError as exc:
        fail(409, exc.code, str(exc))
    if not allowance(db, exam, user.id, sessions)["can_start_new"]:
        fail(409, "ATTEMPT_LIMIT", "Đã hết lượt làm bài. Liên hệ admin để được cấp thêm lượt.")
    last_number = db.scalar(select(func.max(ExamSession.attempt_number)).where(
        ExamSession.exam_id == exam.id, ExamSession.student_id == user.id,
    )) or 0
    session = ExamSession(exam_id=exam.id, student_id=user.id, attempt_number=last_number + 1)
    db.add(session)
    db.flush()
    session.desktop_policy = desktop_policy(db)
    session.screen_required = has_role(user, "STUDENT") and session.desktop_policy["require_screen"] and not exam.snapshot.get("practice", False)
    session.desktop_policy = dict(session.desktop_policy, require_screen=session.screen_required)
    for index, question in enumerate(exam.snapshot["questions"]):
        db.add(Attempt(session_id=session.id, sequence=index + 1, question=question))
    db.commit()
    return public_session(db, session)


@router.get("/exam-sessions/{key}")
def get_session(key: str, db: Session = Depends(get_db), user=Depends(current_user)):
    return public_session(db, owned_session(db, key, user))


@router.post("/exam-sessions/{key}/start")
def start_session(key: str, body: s.ExamStartIn | None = None, db: Session = Depends(get_db), user=Depends(current_user)):
    session = owned_session(db, key, user, lock=True)
    if session.status == "DEVICE_CHECK":
        if session.screen_required:
            if not body or not body.screen_consent:
                fail(409, "SCREEN_CONSENT_REQUIRED", "Đồng ý và bật ghi toàn màn hình trước khi bắt đầu thi")
            session.screen_consent_at = time.time()
        check_schedule(db, by_id(db, Exam, session.exam_id), user)
        try:
            check_config(by_id(db, Exam, session.exam_id))
        except GradingError as exc:
            fail(409, exc.code, str(exc))
        session.status, session.started_at = "IN_PROGRESS", time.time()
        db.add(Audit(user_id=user.id, event="START_EXAM", details={"session_id": key}))
        db.commit()
    elif session.status != "IN_PROGRESS":
        fail(409, "INVALID_STATE", "Không thể bắt đầu lại bài đã nộp")
    return public_session(db, session)


@router.post("/exam-sessions/{key}/proctoring-events", status_code=201)
def proctoring_event(key: str, body: s.ProctoringEventIn, db: Session = Depends(get_db), user=Depends(current_user)):
    session = owned_session(db, key, user, lock=True)
    if session.status != "IN_PROGRESS":
        fail(409, "INVALID_STATE", "Chỉ ghi nhận giám sát khi đang thi")
    # A bounded append-only record. Repeated events do not grow without limit.
    count = db.scalar(select(func.count()).select_from(Audit).where(Audit.event == "PROCTORING_EVENT", Audit.details["session_id"].as_string() == key))
    if count < 500:
        db.add(Audit(user_id=user.id, event="PROCTORING_EVENT", details={"session_id": key, "type": body.type}))
        db.commit()
    return {"ok": True}


def question_clock(attempt, session, time_limit):
    exam_deadline = session.started_at + time_limit
    return {"server_time": time.time(),
            "ready_at": (attempt.prepared_at + attempt.question.get("preparation_seconds", 10)) if attempt.prepared_at else None,
            "recording_deadline": min(attempt.started_at + attempt.question.get("recording_seconds", 60), exam_deadline) if attempt.started_at else None}



@router.post("/question-attempts/{key}/prepare")
def prepare_attempt(key: str, db: Session = Depends(get_db), user=Depends(current_user)):
    attempt, session = owned_attempt(db, key, user, lock=True)
    active(db, session)
    if db.scalar(select(Attempt.id).where(Attempt.session_id == session.id,
        Attempt.sequence < attempt.sequence, Attempt.status.in_(["READY", "STARTED"]))):
        fail(409, "QUESTION_ORDER", "Hãy trả lời câu trước")
    if attempt.status not in {"READY", "STARTED"}:
        fail(409, "INVALID_STATE", "Câu trả lời đã được nộp")
    if attempt.prepared_at is None:
        attempt.prepared_at = time.time()
        db.commit()
    return question_clock(attempt, session, by_id(db, Exam, session.exam_id).time_limit)


@router.post("/question-attempts/{key}/start")
def start_attempt(key: str, db: Session = Depends(get_db), user=Depends(current_user)):
    attempt, session = owned_attempt(db, key, user, lock=True)
    active(db, session)
    earlier = db.scalar(
        select(Attempt).where(
            Attempt.session_id == session.id,
            Attempt.sequence < attempt.sequence,
            Attempt.status.in_(["READY", "STARTED"]),
        )
    )
    if earlier:
        fail(409, "QUESTION_ORDER", "Hãy trả lời câu trước")
    if attempt.prepared_at is not None and time.time() < attempt.prepared_at + attempt.question.get("preparation_seconds", 10):
        fail(409, "PREPARATION_PENDING", "Chưa hết thời gian chuẩn bị")
    if attempt.started_at and time.time() >= attempt.started_at + attempt.question.get("recording_seconds", 60):
        fail(409, "ANSWER_EXPIRED", "Đã hết thời gian trả lời câu hỏi")
    if attempt.status == "READY":
        attempt.status, attempt.started_at = "STARTED", time.time()
        db.add(Audit(user_id=user.id, event="START_QUESTION", details={"attempt_id": key}))
        db.commit()
    elif attempt.status != "STARTED":
        fail(409, "INVALID_STATE", "Câu trả lời đã được nộp")
    return {"status": attempt.status} | question_clock(attempt, session, by_id(db, Exam, session.exam_id).time_limit)


@router.post("/question-attempts/{key}/submit")
def submit(
    key: str,
    body: s.TranscriptIn,
    request: Request,
    idempotency_key: str = Header(min_length=8, max_length=100),
    db: Session = Depends(get_db),
    user=Depends(current_user),
):
    attempt, session = owned_attempt(db, key, user, lock=True)
    if body.stt_skipped_reason and (not has_role(user, "STUDENT") or request.headers.get("x-oral-client") != "desktop"):
        # This identifies the supported channel, not trusted device attestation.
        # A skipped answer can only require review; it cannot earn an AI score.
        fail(403, "DESKTOP_STT_SKIP_REQUIRED", "Chỉ hỗ trợ bỏ qua model cục bộ khi sinh viên thi trên desktop")
    job = db.scalar(select(ProcessingJob).where(ProcessingJob.attempt_id == key))
    if attempt.submit_key:
        if attempt.submit_key == idempotency_key:
            return {"status": attempt.status}
        fail(409, "ALREADY_SUBMITTED", "Câu trả lời đã được nộp")
    # A started answer may arrive after the deadline; preserve it for review, never lose its transcript.
    if session.status != "IN_PROGRESS" or attempt.status != "STARTED":
        fail(409, "INVALID_STATE", "Câu trả lời chưa bắt đầu hoặc bài đã nộp")
    attempt.transcript, attempt.stt_confidence = body.transcript, body.stt_confidence
    attempt.submit_key, attempt.finished_at, attempt.status = idempotency_key, time.time(), "SUBMITTED"
    if body.processing_mode == "server_audio":
        db.add(ProcessingJob(attempt_id=key, policy=processing.server_policy(db, by_id(db, Exam, session.exam_id))))
        db.add(Audit(user_id=user.id, event="AUDIO_ANSWER_SUBMITTED", details={"attempt_id": key}))
    elif body.stt_skipped_reason:
        attempt.assessment = missing_stt_assessment(by_id(db, Exam, session.exam_id))
        # GRADED means initial processing is done. NOT_GRADED + null score means
        # no grading occurred; the worker must never grade a fabricated answer.
        attempt.status = "GRADED"
        db.add(Audit(user_id=user.id, event="STT_SKIPPED", details={
            "attempt_id": key, "stt_status": "unavailable", "stt_skipped_reason": body.stt_skipped_reason,
        }))
    else:
        db.add(Audit(user_id=user.id, event="TRANSCRIPT_SUBMITTED", details={"attempt_id": key}))
    db.commit()
    return {"status": attempt.status}


@router.post("/exam-sessions/{key}/finish")
def finish(key: str, db: Session = Depends(get_db), user=Depends(current_user)):
    session = owned_session(db, key, user, lock=True)
    if session.status in {"SUBMITTED", "COMPLETED", "REVIEW_REQUIRED"}:
        return public_session(db, session)
    if session.status != "IN_PROGRESS":
        fail(409, "INVALID_STATE", "Bài thi chưa bắt đầu")
    attempts = db.scalars(select(Attempt).where(Attempt.session_id == key)).all()
    exam = by_id(db, Exam, session.exam_id)
    expired = time.time() > session.started_at + exam.time_limit
    if any(a.status in {"READY", "STARTED"} for a in attempts) and not expired:
        fail(409, "INCOMPLETE", "Cần trả lời đủ câu trước khi nộp bài")
    if expired:
        for a in attempts:
            if a.status in {"READY", "STARTED"}:
                a.status = "GRADED"
                a.assessment = {
                    "score": None,
                    "review_required": True,
                    "confidence": None,
                    "status": "NOT_GRADED",
                    "reasoning_summary": "Hết giờ, chưa có câu trả lời.",
                }
    # Evidence is required for each submitted voice answer.
    if session.screen_required and not db.scalar(select(Upload.id).join(Attempt).where(
            Attempt.session_id == key, Upload.kind == "SCREEN", Upload.status == "COMPLETED")):
        fail(409, "SCREEN_EVIDENCE_PENDING", "Chờ tải bản ghi màn hình trước khi nộp bài")
    for a in attempts:
        if a.submit_key or a.transcript:
            kinds = set(
                db.scalars(select(Upload.kind).where(Upload.attempt_id == a.id, Upload.status == "COMPLETED"))
            )
            required_kinds = {"AUDIO"}
            if not required_kinds <= kinds:
                fail(409, "EVIDENCE_PENDING", "Chờ tải audio từng câu trước khi nộp bài")
    session.status, session.completed_at = "SUBMITTED", time.time()
    processing.queue_session(db, key)
    db.flush()
    finalize(db, session)
    db.add(Audit(user_id=user.id, event="FINISH_EXAM", details={"session_id": key}))
    db.commit()
    return public_session(db, session)


@router.post("/uploads/init")
def init_upload(body: s.UploadIn, db: Session = Depends(get_db), user=Depends(current_user)):
    # Serialize both duplicate retries and different files for the same answer.
    # Locking only existing uploads leaves a race when neither request has inserted yet.
    attempt, session = owned_attempt(db, body.attempt_id, user, lock=True)
    if (attempt.status == "READY" and body.kind != "SCREEN") or session.status != "IN_PROGRESS":
        fail(409, "INVALID_STATE", "Chỉ upload khi câu trả lời đã bắt đầu và bài chưa nộp")
    media_kind = "video" if body.kind == "SCREEN" else body.kind.lower()
    if not body.mime_type.startswith(media_kind + "/"):
        fail(422, "MIME_MISMATCH", "Loại file không khớp evidence")
    if body.size > settings().max_media_mb * 1024 * 1024:
        fail(413, "MEDIA_TOO_LARGE", "Media quá lớn")
    existing = db.scalar(
        select(Upload).where(
            Upload.attempt_id == attempt.id,
            Upload.kind == body.kind,
            Upload.sha256 == body.sha256,
            Upload.size == body.size,
        )
    )
    if existing:
        return {"id": existing.id, "chunk_size": settings().media_chunk_bytes, "status": existing.status}
    if body.kind != "SCREEN" and db.scalar(select(Upload.id).where(
        Upload.attempt_id == attempt.id, Upload.kind == body.kind,
    ).limit(1)):
        fail(409, "EVIDENCE_ALREADY_EXISTS", "Câu trả lời đã có bản ghi loại này. Chỉ được tải lại đúng file ban đầu.")
    row = Upload(**body.model_dump(), total_chunks=math.ceil(body.size / settings().media_chunk_bytes))
    db.add(row)
    db.flush()
    db.add(Audit(user_id=user.id, event="UPLOAD_STARTED", details={"upload_id": row.id}))
    db.commit()
    return {"id": row.id, "chunk_size": settings().media_chunk_bytes, "status": row.status}


def upload_folder(key):
    # key is always a UUID loaded from the database, never a client file path.
    folder = Path(settings().data_dir) / "uploads" / key
    folder.mkdir(parents=True, exist_ok=True)
    return folder


@router.put("/uploads/{key}/chunks/{index}")
async def chunk(
    key: str,
    index: int,
    request: Request,
    x_chunk_sha256: str = Header(),
    db: Session = Depends(get_db),
    user=Depends(current_user),
):
    row = by_id(db, Upload, key, lock=True)
    owned_attempt(db, row.attempt_id, user)
    if row.status == "COMPLETED":
        return {"ok": True, "index": index, "status": "COMPLETED"}
    if not 0 <= index < row.total_chunks:
        fail(422, "CHUNK_INDEX", "Chunk index không hợp lệ")
    expected = min(settings().media_chunk_bytes, row.size - index * settings().media_chunk_bytes)
    folder = upload_folder(row.id)
    chunk_file = folder / str(index)
    if chunk_file.is_file() and chunk_file.stat().st_size == expected:
        existing_hash = hashlib.sha256(chunk_file.read_bytes()).hexdigest()
        if existing_hash == x_chunk_sha256:
            return {"ok": True, "index": index, "already_received": True}
    content = bytearray()
    async for part in request.stream():
        content.extend(part)
        if len(content) > expected:
            fail(413, "CHUNK_SIZE", "Chunk quá lớn")
    if len(content) != expected or hashlib.sha256(content).hexdigest() != x_chunk_sha256:
        fail(422, "CHECKSUM_MISMATCH", "Kích thước hoặc checksum chunk không khớp")
    with tempfile.NamedTemporaryFile(dir=folder, delete=False) as temp:
        temp.write(content)
        tmp = temp.name
    os.replace(tmp, chunk_file)
    db.commit()
    return {"ok": True, "index": index}


@router.get("/uploads/{key}/status")
def upload_status(key: str, db: Session = Depends(get_db), user=Depends(current_user)):
    row = by_id(db, Upload, key)
    owned_attempt(db, row.attempt_id, user)
    return {
        "status": row.status,
        "received_chunks": sorted(int(p.name) for p in upload_folder(row.id).iterdir() if p.name.isdigit()),
        "total_chunks": row.total_chunks,
    }


@router.post("/uploads/{key}/complete")
def complete(key: str, db: Session = Depends(get_db), user=Depends(current_user)):
    row = by_id(db, Upload, key, lock=True)
    owned_attempt(db, row.attempt_id, user)
    if row.status == "COMPLETED":
        return {"status": row.status}
    folder = upload_folder(row.id)
    if any(not (folder / str(i)).is_file() for i in range(row.total_chunks)):
        fail(409, "MISSING_CHUNKS", "Thiếu chunk")
    content = b"".join((folder / str(i)).read_bytes() for i in range(row.total_chunks))
    if len(content) != row.size or hashlib.sha256(content).hexdigest() != row.sha256:
        fail(422, "CHECKSUM_MISMATCH", "Checksum toàn file không khớp")
    if not (content.startswith(b"\x1aE\xdf\xa3") or content.startswith(b"OggS") or content[4:8] == b"ftyp"):
        fail(422, "INVALID_MEDIA", "Container media không hợp lệ")
    row.storage_key = f"evidence/{row.id}"
    storage.put(row.storage_key, content, row.mime_type)
    row.status = "COMPLETED"
    db.add(Audit(user_id=user.id, event="UPLOAD_COMPLETED", details={"upload_id": row.id}))
    db.commit()
    for part in folder.iterdir():
        part.unlink(missing_ok=True)
    return {"status": row.status}


@router.get("/evidence/{key}/content")
def evidence(key: str, request: Request, db: Session = Depends(get_db), user=Depends(current_user)):
    row = by_id(db, Upload, key)
    attempt = by_id(db, Attempt, row.attempt_id)
    session = by_id(db, ExamSession, attempt.session_id)
    if session.deleted_at is not None:
        fail(404, "NOT_FOUND", "Lần thi đã bị xóa")
    exam = by_id(db, Exam, session.exam_id)
    if exam.course_id == COURSE_ID or (exam.snapshot or {}).get("practice"):
        fail(410, "PRACTICE_DISABLED", "Chức năng học và thi thử đã ngừng sử dụng")
    if session.student_id != user.id:
        if not has_role(user, "ADMIN", "TEACHER", "EXAM_OFFICER"):
            fail(403, "FORBIDDEN", "Minh chứng không thuộc tài khoản")
        exam_access(db, exam, user)
    if row.status != "COMPLETED":
        fail(409, "NOT_READY", "Evidence chưa sẵn sàng")
    start, end, status = 0, row.size - 1, 200
    raw = request.headers.get("range")
    if raw:
        try:
            unit, interval = raw.split("=", 1)
            left, right = interval.split("-", 1)
            if unit != "bytes" or "," in interval:
                raise ValueError()
            if left:
                start = int(left)
                end = min(int(right), end) if right else end
            else:
                start = max(0, row.size - int(right))
            if start < 0 or start > end or start >= row.size:
                raise ValueError()
            status = 206
        except ValueError:
            fail(416, "INVALID_RANGE", "Range không hợp lệ")

    def stream():
        body = storage.open_stream(row.storage_key)
        try:
            remaining_skip = start
            while remaining_skip:
                part = body.read(min(65536, remaining_skip))
                if not part:
                    return
                remaining_skip -= len(part)
            remaining = end - start + 1
            while remaining:
                part = body.read(min(65536, remaining))
                if not part:
                    return
                remaining -= len(part)
                yield part
        finally:
            body.close()

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
        "Cache-Control": "private, no-store",
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{row.size}"
    return StreamingResponse(stream(), status_code=status, media_type=row.mime_type, headers=headers)
