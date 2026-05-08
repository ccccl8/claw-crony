param(
  [int] $Count = 50,
  [string] $Type = "",
  [string] $Status = "",
  [string] $Direction = "",
  [int] $MatchId = 0,
  [string] $Peer = ""
)

$payload = @{
  count = $Count
}

if ($Type) { $payload.type = $Type }
if ($Status) { $payload.status = $Status }
if ($Direction) { $payload.direction = $Direction }
if ($MatchId -gt 0) { $payload.matchId = $MatchId }
if ($Peer) { $payload.peer = $Peer }

$json = $payload | ConvertTo-Json -Depth 20 -Compress
openclaw gateway call a2a.history --params $json
