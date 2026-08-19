const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();
const resDir = path.join(projectRoot, 'android', 'app', 'src', 'main', 'res');
const xmlDir = path.join(resDir, 'xml');

if (!fs.existsSync(xmlDir)) {
  fs.mkdirSync(xmlDir, { recursive: true });
}

const securityConfigPath = path.join(xmlDir, 'network_security_config.xml');
const securityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
    <domain-config>
        <domain includeSubdomains="true">13.126.205.202</domain>
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </domain-config>
</network-security-config>`;

fs.writeFileSync(securityConfigPath, securityConfig);
console.log('✅ Created network_security_config.xml');

// Also update AndroidManifest.xml to ensure it has the right attributes
const manifestPath = path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  
  // Add networkSecurityConfig if not present
  if (!manifest.includes('android:networkSecurityConfig')) {
    manifest = manifest.replace(
      /<application([^>]*)>/,
      '<application$1 android:networkSecurityConfig="@xml/network_security_config">'
    );
    fs.writeFileSync(manifestPath, manifest);
    console.log('✅ Updated AndroidManifest.xml with networkSecurityConfig');
  }
  
  // Add usesCleartextTraffic if not present
  if (!manifest.includes('android:usesCleartextTraffic')) {
    manifest = manifest.replace(
      /<application([^>]*)>/,
      '<application$1 android:usesCleartextTraffic="true">'
    );
    fs.writeFileSync(manifestPath, manifest);
    console.log('✅ Updated AndroidManifest.xml with usesCleartextTraffic');
  }
}
