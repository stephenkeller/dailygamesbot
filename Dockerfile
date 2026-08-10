FROM python:3.10-slim

WORKDIR /app

# Create data directory for persistent SQLite volume
RUN mkdir -p /app/data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run unbuffered so logs appear immediately
CMD ["python", "-u", "bot.py"]
