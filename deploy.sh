#!/bin/bash
cd ~/Gatekeeper
git pull
docker compose up --build -d
echo "✅ GateKeeper deployed"
