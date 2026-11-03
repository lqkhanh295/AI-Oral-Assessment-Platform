import time
import pytest
from sqlalchemy import select
from app.circuit_breaker import CircuitBreaker, CircuitOpenError, get_circuit_breaker, reset_all_circuit_breakers
from app.models import ProcessingJob, Attempt, ExamSession, Upload
from test_mvp import ok, prepare, start


def test_circuit_breaker_lifecycle():
    cb = CircuitBreaker("test-service", failure_threshold=3, recovery_timeout=0.2)
    assert cb.state == "CLOSED"
    assert cb.failure_count == 0

    # 1. Normal success
    assert cb.call(lambda x: x * 2, 5) == 10
    assert cb.state == "CLOSED"

    # 2. Failures below threshold
    def fail_call():
        raise RuntimeError("Transient connection failure")

    with pytest.raises(RuntimeError):
        cb.call(fail_call)
    assert cb.failure_count == 1
    assert cb.state == "CLOSED"

    with pytest.raises(RuntimeError):
        cb.call(fail_call)
    assert cb.failure_count == 2
    assert cb.state == "CLOSED"

    # 3. Third failure triggers OPEN
    with pytest.raises(RuntimeError):
        cb.call(fail_call)
    assert cb.state == "OPEN"

    # 4. While OPEN, fails fast with CircuitOpenError without calling function
    executed = False
    def probe():
        nonlocal executed
        executed = True
        return "ok"

    with pytest.raises(CircuitOpenError) as exc_info:
        cb.call(probe)
    assert not executed
    assert "is OPEN" in str(exc_info.value)

    # 5. After recovery timeout, allows 1 trial call in HALF_OPEN
    time.sleep(0.25)
    result = cb.call(probe)
    assert executed
    assert result == "ok"
    assert cb.state == "CLOSED"
    assert cb.failure_count == 0


def test_circuit_breaker_half_open_failure_reopens():
    cb = CircuitBreaker("test-probe-fail", failure_threshold=2, recovery_timeout=0.1)

    def fail_call():
        raise ValueError("Service down")

    with pytest.raises(ValueError):
        cb.call(fail_call)
    with pytest.raises(ValueError):
        cb.call(fail_call)
    assert cb.state == "OPEN"

    time.sleep(0.15)
    # Probe fails in HALF_OPEN
    with pytest.raises(ValueError):
        cb.call(fail_call)
    assert cb.state == "OPEN"


def test_stage_resumption_does_not_repeat_stt(env, monkeypatch):
    from app import worker, speech
    from test_server_processing import submitted, success_stt, success_grade

    context, session, aids = submitted(env)
    clients, factory = env
    path = f"/exam-sessions/{session['id']}"

    stt_calls = 0
    def tracking_stt(audio_path, policy):
        nonlocal stt_calls
        stt_calls += 1
        return {"transcript": "Checkpoint transcript", "stt_confidence": 0.95}

    grade_calls = 0
    def failing_then_success_grade(*args, **kwargs):
        nonlocal grade_calls
        grade_calls += 1
        if grade_calls == 1:
            raise RuntimeError("Transient Gemini rate limit (429)")
        return success_grade(*args, **kwargs)

    monkeypatch.setattr(speech, "transcribe_file", tracking_stt)
    monkeypatch.setattr(worker, "grade_answer", failing_then_success_grade)

    # Enable multi-retry in config
    from app import runtime_settings
    monkeypatch.setattr(runtime_settings.settings(), "processing_max_retries", 3)

    # Step 1: STT tick
    assert worker.tick()
    assert stt_calls == 1

    # Step 2: Grading tick fails -> should trigger RETRY backoff without marking job FAILED
    with factory() as db:
        job = db.scalar(select(ProcessingJob).where(ProcessingJob.attempt_id == aids[0]))
        assert job.status == "QUEUED_GRADING"
        assert job.stage == "GRADING"

    # Tick runs grading and fails run 1
    assert worker.tick()
    assert grade_calls == 1
    with factory() as db:
        job = db.scalar(select(ProcessingJob).where(ProcessingJob.attempt_id == aids[0]))
        # Status remains QUEUED_GRADING with RETRY info
        assert job.status == "QUEUED_GRADING"
        assert "RETRY_2" in job.error
        # Reset updated_at so next tick can immediately process
        job.updated_at = time.time() - 10
        db.commit()

    # Step 3: Next tick runs grading again (run 2) -> succeeds!
    assert worker.tick()
    assert grade_calls == 2
    # Verify STT was NOT called a second time!
    assert stt_calls == 1

    # Verify session completed successfully
    final = ok(clients["admin"].get(f"/admin/results/{session['id']}"))
    assert final["status"] == "COMPLETED"
    assert final["attempts"][0]["transcript"] == "Checkpoint transcript"
