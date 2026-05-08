param(
  [Parameter(Mandatory = $true)]
  [string[]] $Skills,
  [string] $Description = ""
)

$payload = @{
  skills = $Skills
}

if ($Description) {
  $payload.description = $Description
}

$json = $payload | ConvertTo-Json -Depth 20 -Compress
openclaw gateway call a2a.match --params $json
