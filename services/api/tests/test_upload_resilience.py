import hashlib
import pytest
from test_mvp import ok, prepare, start
from app.models import Upload


def test_chunk_upload_resilience_and_idempotency(env):
    context = prepare(env, 1)
    clients, factory = env
    student = clients["student"]
    session = start(env, context)
    aid = session["current_attempt"]["id"]
    ok(student.post(f"/question-attempts/{aid}/start"))

    blob = b"\x1aE\xdf\xa3" + b"resilience-test-bytes" * 50
    checksum = hashlib.sha256(blob).hexdigest()
    data = {
        "attempt_id": aid,
        "kind": "AUDIO",
        "mime_type": "audio/webm",
        "size": len(blob),
        "sha256": checksum,
    }
    
    # 1. Init upload
    init_res = ok(student.post("/uploads/init", json=data))
    upload_id = init_res["id"]
    
    # 2. Upload chunk 0 for the first time
    chunk_res1 = ok(student.put(
        f"/uploads/{upload_id}/chunks/0",
        content=blob,
        headers={"X-Chunk-Sha256": checksum}
    ))
    assert chunk_res1["ok"] is True
    assert chunk_res1["index"] == 0
    assert not chunk_res1.get("already_received")

    # 3. Simulate network glitch retry: upload same chunk 0 again
    chunk_res2 = ok(student.put(
        f"/uploads/{upload_id}/chunks/0",
        content=blob,
        headers={"X-Chunk-Sha256": checksum}
    ))
    assert chunk_res2["ok"] is True
    assert chunk_res2["index"] == 0
    assert chunk_res2.get("already_received") is True  # Idempotently recognized without error

    # 4. Check upload status
    status_res = ok(student.get(f"/uploads/{upload_id}/status"))
    assert status_res["received_chunks"] == [0]
    assert status_res["total_chunks"] == 1

    # 5. Complete upload
    complete_res = ok(student.post(f"/uploads/{upload_id}/complete"))
    assert complete_res["status"] == "COMPLETED"

    # 6. Simulate client retry of chunk 0 AFTER upload was already completed
    # Should safely return status: COMPLETED rather than throwing 409 error
    chunk_res3 = ok(student.put(
        f"/uploads/{upload_id}/chunks/0",
        content=blob,
        headers={"X-Chunk-Sha256": checksum}
    ))
    assert chunk_res3["ok"] is True
    assert chunk_res3["status"] == "COMPLETED"


def test_question_submit_idempotency_with_server_audio(env):
    context = prepare(env, 1)
    clients, factory = env
    student = clients["student"]
    session = start(env, context)
    aid = session["current_attempt"]["id"]
    ok(student.post(f"/question-attempts/{aid}/start"))

    blob = b"\x1aE\xdf\xa3" + b"server-audio-answer" * 50
    checksum = hashlib.sha256(blob).hexdigest()
    data = {
        "attempt_id": aid,
        "kind": "AUDIO",
        "mime_type": "audio/webm",
        "size": len(blob),
        "sha256": checksum,
    }
    init_res = ok(student.post("/uploads/init", json=data))
    ok(student.put(
        f"/uploads/{init_res['id']}/chunks/0",
        content=blob,
        headers={"X-Chunk-Sha256": checksum}
    ))
    ok(student.post(f"/uploads/{init_res['id']}/complete"))

    idempotency_key = "test-resilience-idemp-key-12345"
    submit_body = {
        "transcript": "",
        "stt_confidence": None,
        "processing_mode": "server_audio"
    }

    # 1. First submit
    sub1 = ok(student.post(
        f"/question-attempts/{aid}/submit",
        json=submit_body,
        headers={"Idempotency-Key": idempotency_key}
    ))
    assert sub1["status"] == "SUBMITTED"

    # 2. Retry submit with identical idempotency key (simulating network retry)
    sub2 = ok(student.post(
        f"/question-attempts/{aid}/submit",
        json=submit_body,
        headers={"Idempotency-Key": idempotency_key}
    ))
    assert sub2["status"] == "SUBMITTED"

    # 3. Submit with different idempotency key should fail with 409
    sub3 = student.post(
        f"/question-attempts/{aid}/submit",
        json=submit_body,
        headers={"Idempotency-Key": "different-key-99999"}
    )
    assert sub3.status_code == 409
    assert sub3.json()["error"]["code"] == "ALREADY_SUBMITTED"
