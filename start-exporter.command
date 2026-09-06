#!/bin/zsh
cd "$(dirname "$0")"
echo "Starting Web Highlighter Notes export service..."
echo "Keep this window open while exporting notes."
exec npm run exporter
