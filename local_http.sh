#!/bin/bash

python3 -m http.server 8080 >/dev/null &
echo http://localhost:8080
