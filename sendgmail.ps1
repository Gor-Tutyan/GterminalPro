param([string]$Subject = "Test Email", [string]$Body = "This is a test.")

$From = "dltutyan@gmail.com"
$To = "dltutyan@gmail.com"
$AppPassword = "G.tutyan1996"   # ← CHANGE THIS

Send-MailMessage `
    -From $From `
    -To $To `
    -Subject $Subject `
    -Body $Body `
    -SmtpServer "smtp.gmail.com" `
    -Port 587 `
    -UseSsl `
    -Credential (New-Object System.Management.Automation.PSCredential ($From, (ConvertTo-SecureString $AppPassword -AsPlainText -Force)))
    
Write-Host "Email sent successfully!" -ForegroundColor Green