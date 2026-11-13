#!/bin/bash

nohup python3 -m http.server 9000 >/dev/null &
echo http://localhost:9000
