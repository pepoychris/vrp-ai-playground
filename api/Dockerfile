# RoboRoute Nexus API image (MVP Phase 1).
#
# The base tag is pinned in docs/contracts/versions.md; "latest" is never used.
FROM python:3.14.7-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Locked dependency set first, so the dependencies layer is cached while the
# application code changes.
COPY requirements.lock.txt ./requirements.lock.txt
RUN python -m pip install --requirement requirements.lock.txt

COPY app ./app

# The SQLite file lives on the persistent volume mounted at /data. Nothing writes
# to it in Phase 1, but the directory must exist and be writable by the runtime
# user, otherwise the named volume would be created with root ownership.
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /data

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
