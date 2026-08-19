const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const withAndroidNetworkSecurity = (config) => {
  // Modify the manifest
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    
    // Find application tag
    let application = manifest.manifest.application;
    if (Array.isArray(application)) {
      application = application[0];
    }
    
    if (!application.$) {
      application.$ = {};
    }
    
    // Add cleartext traffic permission and network security config reference
    application.$['android:usesCleartextTraffic'] = 'true';
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    
    return config;
  });
  
  // Use withDangerousMod to write additional files
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const { projectRoot } = config.modRequest;
      const resDir = path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'xml');
      
      console.log('Creating network_security_config.xml in:', resDir);
      
      if (!fs.existsSync(resDir)) {
        fs.mkdirSync(resDir, { recursive: true });
      }
      
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
      
      fs.writeFileSync(path.join(resDir, 'network_security_config.xml'), securityConfig);
      console.log('✅ Created network_security_config.xml');
      
      return config;
    },
  ]);
  
  return config;
};

module.exports = withAndroidNetworkSecurity;
