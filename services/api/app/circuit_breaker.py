"""Thread-safe Circuit Breaker for AI and external services.

Prevents worker thread pool exhaustion when external dependencies
(Gemini API, Ollama LLM, HuBERT/GOPT Pronunciation, STT) experience outages.
"""

import logging
import threading
import time
from typing import Any, Callable, Dict, Optional

log = logging.getLogger("oral.circuit_breaker")


class CircuitOpenError(Exception):
    """Raised when an operation is attempted while the circuit breaker is OPEN."""

    def __init__(self, service_name: str, retry_after: float):
        self.service_name = service_name
        self.retry_after = retry_after
        super().__init__(
            f"Circuit breaker for '{service_name}' is OPEN. "
            f"Failing fast to protect thread pool. Retry after {retry_after:.1f}s."
        )


class CircuitBreaker:
    """Tracks error rates and fails fast during persistent outages."""

    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        recovery_timeout: float = 30.0,
    ):
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.state: str = "CLOSED"  # CLOSED, OPEN, HALF_OPEN
        self.failure_count: int = 0
        self.success_count: int = 0
        self.last_failure_time: float = 0.0
        self.last_state_change: float = time.time()
        self._lock = threading.Lock()

    def call(self, func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            now = time.time()
            if self.state == "OPEN":
                elapsed = now - self.last_failure_time
                if elapsed >= self.recovery_timeout:
                    log.info("Circuit breaker '%s' entering HALF_OPEN probe state", self.name)
                    self.state = "HALF_OPEN"
                else:
                    raise CircuitOpenError(self.name, self.recovery_timeout - elapsed)

        try:
            result = func(*args, **kwargs)
            self.on_success()
            return result
        except Exception as exc:
            self.on_failure(exc)
            raise

    def on_success(self) -> None:
        with self._lock:
            if self.state == "HALF_OPEN":
                log.info("Circuit breaker '%s' recovered! State is now CLOSED", self.name)
                self.state = "CLOSED"
                self.failure_count = 0
                self.last_state_change = time.time()
            elif self.state == "CLOSED":
                self.failure_count = 0
            self.success_count += 1

    def on_failure(self, exc: Exception) -> None:
        with self._lock:
            self.failure_count += 1
            self.last_failure_time = time.time()
            if self.state == "HALF_OPEN":
                log.warning(
                    "Circuit breaker '%s' probe failed (%s). Reopening circuit for %.1fs",
                    self.name,
                    type(exc).__name__,
                    self.recovery_timeout,
                )
                self.state = "OPEN"
                self.last_state_change = time.time()
            elif self.state == "CLOSED" and self.failure_count >= self.failure_threshold:
                log.warning(
                    "Circuit breaker '%s' tripped OPEN after %d consecutive failures (%s). Cooling down for %.1fs",
                    self.name,
                    self.failure_count,
                    type(exc).__name__,
                    self.recovery_timeout,
                )
                self.state = "OPEN"
                self.last_state_change = time.time()

    def reset(self) -> None:
        with self._lock:
            self.state = "CLOSED"
            self.failure_count = 0
            self.last_failure_time = 0.0
            self.last_state_change = time.time()

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "name": self.name,
                "state": self.state,
                "failure_count": self.failure_count,
                "success_count": self.success_count,
                "last_state_change": self.last_state_change,
            }


_registry: Dict[str, CircuitBreaker] = {}
_registry_lock = threading.Lock()


def get_circuit_breaker(
    name: str,
    failure_threshold: int = 5,
    recovery_timeout: float = 30.0,
) -> CircuitBreaker:
    with _registry_lock:
        if name not in _registry:
            _registry[name] = CircuitBreaker(
                name=name,
                failure_threshold=failure_threshold,
                recovery_timeout=recovery_timeout,
            )
        return _registry[name]


def circuit_breaker_states() -> Dict[str, Dict[str, Any]]:
    with _registry_lock:
        return {name: cb.status() for name, cb in _registry.items()}


def reset_all_circuit_breakers() -> None:
    with _registry_lock:
        for cb in _registry.values():
            cb.reset()
