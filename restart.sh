#!/bin/bash
# Graceful restart script for bytelight
# Rebuilds, then restarts PM2 process

set -e

echo "Building..."
npm run build

echo "Restarting PM2 process..."
pm2 restart bytelight

echo "Done! Checking status..."
pm2 status bytelight
