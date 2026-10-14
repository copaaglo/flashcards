FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker/ worker/

RUN useradd --create-home appuser
USER appuser

# Listen on the "jobs" queue. sh -c lets us read REDIS_URL from the environment.
CMD ["sh", "-c", "rq worker jobs --url \"$REDIS_URL\""]