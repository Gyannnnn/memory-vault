FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
COPY face_worker face_worker
RUN pip install .
RUN useradd --system --uid 10001 worker && mkdir -p /models && chown worker /models
USER worker
EXPOSE 8090
CMD ["python", "-m", "face_worker.server"]
