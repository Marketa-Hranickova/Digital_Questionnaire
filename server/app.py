"""VFQ-25 proxy server: sits between the iPad UI and REDCap.

Endpoints:
    POST /api/sessions                  staff PIN + patient code -> one-time session token
    POST /api/responses                 patient UI submits a QuestionnaireResponse (Bearer token)
    GET  /api/records/{pid}/pdf         staff downloads the PDF (X-Staff-Pin header)
    GET  /api/health                    liveness check, no data

Run (development, mock REDCap):
    STAFF_PIN=123456 uvicorn server.app:app --reload
"""
import hashlib
import json
import logging
import re

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .auth import AuthError, LockedOut, PinGuard, SessionStore
from .config import load_settings
from .redcap import MockRedcap, RealRedcap, RedcapError, to_record
from .validation import QuestionnaireRules, ValidationError, validate_response

log = logging.getLogger("vfq25")


def pid_ref(pid):
    """Short hash for logs, so even the pseudonym does not appear in log files."""
    return hashlib.sha256(pid.encode()).hexdigest()[:8]


class SessionRequest(BaseModel):
    pid: str = Field(max_length=20)
    include_appendix: bool = False
    skip_q1: bool = False


def create_app(settings=None, redcap=None):
    settings = settings or load_settings()
    with open(settings.questionnaire_path, encoding="utf-8") as f:
        rules = QuestionnaireRules(json.load(f))
    if redcap is None:
        redcap = (MockRedcap() if settings.redcap_mode == "mock"
                  else RealRedcap(settings.redcap_api_url, settings.redcap_api_token))

    pins = PinGuard(settings.staff_pin, settings.max_pin_attempts, settings.pin_lockout_seconds)
    sessions = SessionStore(settings.session_ttl_seconds)

    # No interactive API docs: they would publish the API surface on the clinic network
    app = FastAPI(title="VFQ-25 proxy", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.redcap = redcap
    app.state.sessions = sessions

    if settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.allowed_origins),
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type", "X-Staff-Pin"],
        )

    @app.middleware("http")
    async def limits_and_headers(request: Request, call_next):
        # Body size cap (the reverse proxy in front should enforce the same limit, since
        # chunked requests carry no Content-Length)
        length = request.headers.get("content-length", "0")
        if not length.isdigit() or int(length) > settings.max_body_bytes:
            return JSONResponse({"detail": "request too large"}, status_code=413)
        response = await call_next(request)
        # Health data must never be cached by the browser or a proxy
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def require_pin(pin):
        try:
            pins.check(pin or "")
        except LockedOut as e:
            raise HTTPException(429, str(e))
        except AuthError:
            raise HTTPException(401, "wrong PIN")

    def check_pid(pid):
        if not re.fullmatch(settings.pid_pattern, pid):
            raise HTTPException(422, "patient code not in the allowed pseudonym format")

    @app.get("/api/health")
    def health():
        return {"status": "ok", "mode": settings.redcap_mode}

    @app.post("/api/sessions", status_code=201)
    def start_session(body: SessionRequest, x_staff_pin: str = Header(default="")):
        require_pin(x_staff_pin)
        check_pid(body.pid)
        token = sessions.create(body.pid, {"include_appendix": body.include_appendix,
                                           "skip_q1": body.skip_q1})
        log.info("session started for %s", pid_ref(body.pid))
        return {"token": token, "expires_in": settings.session_ttl_seconds}

    @app.post("/api/responses", status_code=201)
    async def submit(request: Request, authorization: str = Header(default="")):
        token = authorization.removeprefix("Bearer ").strip()
        try:
            session = sessions.peek(token)
        except AuthError:
            raise HTTPException(401, "invalid or expired session")
        try:
            resp = await request.json()
        except Exception:
            raise HTTPException(400, "body is not valid JSON")
        try:
            answers = validate_response(resp, rules, session.pid, settings.pid_pattern,
                                        session.options)
        except ValidationError as e:
            # The session stays open so the patient can correct and resend
            raise HTTPException(422, str(e))
        record = to_record(session.pid, answers, resp["status"] == "completed",
                           session.options["include_appendix"])
        try:
            redcap.import_record(record)
        except RedcapError as e:
            log.error("REDCap import failed for %s: %s", pid_ref(session.pid), e)
            raise HTTPException(502, "could not save, please tell the staff")
        sessions.consume(token)  # only now: a failed save can be retried with the same token
        log.info("record stored for %s (%d answers)", pid_ref(session.pid), len(answers))
        return {"stored": True, "answers": len(answers)}

    @app.get("/api/records/{pid}/pdf")
    def pdf(pid: str, x_staff_pin: str = Header(default="")):
        require_pin(x_staff_pin)
        check_pid(pid)
        try:
            content = redcap.export_pdf(pid)
        except RedcapError:
            raise HTTPException(404, "no PDF for this code")
        return Response(content, media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="vfq25_{pid}.pdf"'})

    return app


def __getattr__(name):
    # `uvicorn server.app:app` builds the app on first access, reading settings from the env
    if name == "app":
        app = create_app()
        globals()["app"] = app
        return app
    raise AttributeError(name)
