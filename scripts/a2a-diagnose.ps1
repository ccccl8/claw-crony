Write-Host "== OpenClaw Gateway =="
openclaw gateway status

Write-Host "`n== Plugin =="
openclaw plugins inspect claw-crony
openclaw plugins inspect claw-crony --runtime

Write-Host "`n== Peers =="
openclaw gateway call a2a.peers --params "{}"

Write-Host "`n== Metrics =="
openclaw gateway call a2a.metrics --params "{}"

Write-Host "`n== Recent History =="
openclaw gateway call a2a.history --params "{`"count`":20}"
