param([string]$Model)

$proxy = "https://deepclaude-920396162290.us-central1.run.app"

$aliases = @{
    claude     = "anthropic"
    opus       = "anthropic"
    sonnet     = "anthropic"
    anthropic  = "anthropic"
    ds         = "deepseek"
    deepseek   = "deepseek"
    or         = "openrouter"
    openrouter = "openrouter"
    gemma      = "gemma"
    gemma4     = "gemma"
    "ds-rp"    = "deepseek-rp"
    "deepseek-rp" = "deepseek-rp"
    r1         = "deepseek-rp"
    ki         = "kimi"
    kimi       = "kimi"
}

if (-not $Model) {
    $status = Invoke-RestMethod "$proxy/_proxy/status"
    Write-Host "`n  Current: $($status.mode)  (uptime: $($status.uptime)s, requests: $($status.requests))" -ForegroundColor Cyan
    Write-Host "`n  Usage:  switch-model <name>`n"
    Write-Host "  Names:" -ForegroundColor Yellow
    Write-Host "    claude / opus / anthropic  -> Claude Opus/Sonnet"
    Write-Host "    ds / deepseek              -> DeepSeek V4 Pro API"
    Write-Host "    or / openrouter            -> OpenRouter API"
    Write-Host "    gemma / gemma4             -> Gemma 4 E4B (RunPod)"
    Write-Host "    r1 / ds-rp / deepseek-rp   -> DeepSeek R1 (RunPod)"
    Write-Host "    ki / kimi                  -> Kimi K3 (Moonshot)"
    Write-Host ""
    exit 0
}

if ($Model -eq "cost") {
    $cost = Invoke-RestMethod "$proxy/_proxy/cost"
    Write-Host "`n  Cost Summary" -ForegroundColor Cyan
    Write-Host "  Total: `$$($cost.total_cost)  (Anthropic equiv: `$$($cost.anthropic_equivalent), saved: `$$($cost.savings))" -ForegroundColor Green
    foreach ($b in $cost.backends.PSObject.Properties) {
        Write-Host "    $($b.Name): $($b.Value.requests) reqs, $($b.Value.input_tokens)in/$($b.Value.output_tokens)out, `$$($b.Value.cost)"
    }
    Write-Host ""
    exit 0
}

$backend = $aliases[$Model]
if (-not $backend) {
    Write-Host "  Unknown model: $Model" -ForegroundColor Red
    Write-Host "  Valid: claude, ds, or, gemma, r1, kimi" -ForegroundColor Yellow
    exit 1
}

try {
    $result = Invoke-RestMethod -Method POST "$proxy/_proxy/mode" -Body "backend=$backend"
    Write-Host "  Switched: $($result.previous) -> $($result.mode)" -ForegroundColor Green
} catch {
    # A 400 from the proxy throws in PS7; the JSON error body rides on
    # ErrorDetails. Surface it instead of the unreachable $result.error.
    $msg = $_.ErrorDetails.Message
    if ($msg) { try { $msg = ($msg | ConvertFrom-Json).error } catch {} } else { $msg = $_.Exception.Message }
    Write-Host "  Error: $msg" -ForegroundColor Red
    exit 1
}
