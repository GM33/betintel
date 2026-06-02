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

EXPOSE 8001

CMD ["uvicorn", "mlb.api.main:app", "--host", "0.0.0.0", "--port", "8001"]
