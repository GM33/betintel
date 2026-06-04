FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./mlb/requirements.txt
RUN pip install --no-cache-dir -r ./mlb/requirements.txt

COPY . ./mlb/

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
# cache-bust: 2026-06-04

EXPOSE 8080

CMD ["bash", "mlb/start.sh"]
