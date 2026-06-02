FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY mlb/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

EXPOSE 8001

# On first boot: run startup (migrate + seed + train + predict), then serve API
CMD python mlb/startup.py && uvicorn mlb.api.main:app --host 0.0.0.0 --port ${PORT:-8001}
