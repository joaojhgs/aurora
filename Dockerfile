# Aurora Voice Assistant - Production Container
FROM python:3.11-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV AURORA_ENV=production

# Install system dependencies
RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    ffmpeg \
    gcc \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app user
RUN groupadd -r aurora && useradd -r -g aurora -s /bin/bash aurora

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements-docker.txt .
RUN pip install --no-cache-dir -r requirements-docker.txt

# Copy application code
COPY --chown=aurora:aurora app/ app/
COPY --chown=aurora:aurora modules/ modules/
COPY --chown=aurora:aurora main.py .
COPY --chown=aurora:aurora config.json .

# Create necessary directories
RUN mkdir -p /app/data /app/logs /app/cache && \
    chown -R aurora:aurora /app

# Switch to non-root user
USER aurora

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8000/health', timeout=5)" || exit 1

# Expose port
EXPOSE 8000

# Default command
CMD ["python", "main.py", "--server-mode"]
