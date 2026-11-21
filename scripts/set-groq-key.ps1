$ErrorActionPreference = 'Stop'

$secret = Read-Host 'Paste your Groq API key (hidden), then press Enter' -AsSecureString
try {
    $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try {
        $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer).Trim()
        if ($key -cnotmatch '^gsk_[A-Za-z0-9_-]+$') {
            throw 'Expected a Groq API key starting with gsk_. No settings were changed.'
        }
        $env:GROQ_API_KEY = $key
    } finally {
        Remove-Variable key -ErrorAction SilentlyContinue
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer)
    }
} finally {
    $secret.Dispose()
}

Write-Host 'Groq key set for this terminal only. Start the local API from here without overriding GROQ_API_KEY.'
