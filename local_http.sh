#!/bin/bash

nohup python3 -m http.server 8081 >/dev/null &
echo http://localhost:8081
