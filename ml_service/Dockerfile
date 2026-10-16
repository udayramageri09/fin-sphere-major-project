FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1
WORKDIR /app
COPY ml_service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home analytics
COPY --chown=analytics:analytics ml_service/ ./
USER analytics
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "4", "--timeout-keep-alive", "5"]
