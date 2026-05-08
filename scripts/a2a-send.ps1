param(
  [Parameter(Mandatory = $true)]
  [string] $Peer,
  [Parameter(Mandatory = $true)]
  [string] $Text,
  [string] $AgentId = ""
)

$message = @{
  text = $Text
}

if ($AgentId) {
  $message.agentId = $AgentId
}

$payload = @{
  peer = $Peer
  message = $message
}

$json = $payload | ConvertTo-Json -Depth 20 -Compress
openclaw gateway call a2a.send --params $json
