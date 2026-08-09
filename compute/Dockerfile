FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
COPY contracts ./contracts
COPY compute ./compute
RUN pip install --no-cache-dir .

CMD ["python", "-m", "compute.worker"]
