import os

# worker.tasks reads these at import time, so set them BEFORE any test imports it.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:8333")
os.environ.setdefault("S3_BUCKET", "test-uploads")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
# Belt and braces: even if a test forgets to mock the LLM, never call the real API
os.environ["FAKE_LLM"] = "1"
os.environ.pop("ANTHROPIC_API_KEY", None)
