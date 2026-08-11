FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
COPY contracts ./contracts
COPY compute ./compute
RUN pip install --no-cache-dir .

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-m", "compute.healthcheck", "--status-file", "/var/run/calb-worker/status.json"]

CMD ["python", "-m", "compute.worker", "--status-file", "/var/run/calb-worker/status.json"]
