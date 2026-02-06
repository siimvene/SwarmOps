#!/bin/bash
set -e

echo "🦀 SwarmOps Installation"
echo "========================"
echo

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found${NC}"
    echo "  Please install Node.js 20+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}✗ Node.js version too old (found v$NODE_VERSION, need v20+)${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Check/install pnpm
if ! command -v pnpm &> /dev/null; then
    echo -e "${YELLOW}→ Installing pnpm...${NC}"
    npm install -g pnpm
fi
echo -e "${GREEN}✓ pnpm $(pnpm -v)${NC}"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Install dashboard dependencies
echo
echo -e "${YELLOW}→ Installing dashboard dependencies...${NC}"
cd dashboard
pnpm install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# Build for production
echo
echo -e "${YELLOW}→ Building for production...${NC}"
pnpm build
echo -e "${GREEN}✓ Production build complete${NC}"

# Create .env if not exists
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${GREEN}✓ Created .env from .env.example${NC}"
    else
        cat > .env << 'EOF'
# SwarmOps Configuration
NUXT_PUBLIC_API_URL=http://localhost:3939
NUXT_GATEWAY_URL=http://127.0.0.1:18789
NUXT_PROJECTS_DIR=../projects
NUXT_ORCHESTRATOR_DATA_DIR=../data/orchestrator
EOF
        echo -e "${GREEN}✓ Created default .env${NC}"
    fi
else
    echo -e "${GREEN}✓ .env already exists${NC}"
fi

# Create data directories
cd "$SCRIPT_DIR"
mkdir -p data/orchestrator/prompts
mkdir -p projects

# Create roles.json from example if not exists
if [ ! -f data/orchestrator/roles.json ]; then
    if [ -f data/orchestrator/roles.example.json ]; then
        cp data/orchestrator/roles.example.json data/orchestrator/roles.json
        echo -e "${GREEN}✓ Created roles.json from example (9 roles included)${NC}"
    fi
fi

echo
echo -e "${GREEN}✓ Installation complete!${NC}"
echo
echo "Next steps:"
echo "  1. Make sure OpenClaw Gateway is running on port 18789"
echo "  2. Edit dashboard/.env if needed"
echo "  3. Start the server:"
echo
echo "     cd dashboard && node .output/server/index.mjs"
echo
echo "  Dashboard will be available at http://localhost:3000"
echo
