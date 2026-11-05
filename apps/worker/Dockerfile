FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker/ worker/

RUN useradd --create-home appuser
USER appuser

# Prometheus scrapes the worker's metrics here
EXPOSE 9100

# worker/main.py serves /metrics, then listens on the "jobs" queue
CMD ["python", "-m", "worker.main"]
