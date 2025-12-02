FROM docker.io/cloudflare/sandbox:0.6.0

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI using the official install script
RUN curl -fsSL https://opencode.ai/install | bash

# Required during local development to access exposed ports
EXPOSE 8080
