const fs = require('fs');
const path = require('path');

function parseEnv(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  
  const content = fs.readFileSync(filePath, 'utf8');
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [key, ...valParts] = trimmed.split('=');
    if (key) {
      result[key.trim()] = valParts.join('=').trim();
    }
  });
  return result;
}

const envPath = path.resolve(__dirname, '.env');
const env = parseEnv(envPath);

const useLocal = env.USE_LOCAL === 'true';
const apiUrl = useLocal 
  ? (env.API_URL_LOCAL || 'http://192.168.29.103:4000')
  : (env.API_URL_REMOTE || 'http://13.126.205.202:4000');

module.exports = {
  expo: {
    name: "Workout Tracker",
    slug: "workout-tracker",
    scheme: "workouttracker",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "dark",
    splash: {
      backgroundColor: "#0f0f0f"
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.anonymous.workouttracker"
    },
    android: {
      package: "com.anonymous.workouttracker",
      permissions: ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"]
    },
    // plugins: [
    //   "expo-font",
    //   "expo-secure-store",
    //   "./plugins/withAndroidNetworkSecurity"
    // ],
      "plugins": [
      "expo-font",
      "expo-secure-store",
      "./plugins/withAndroidNetworkSecurity",
      [
        "expo-image-picker",
        {
          "cameraPermission": "Allows you to take progress photos.",
          "photosPermission": "Allows you to choose progress photos from your library.",
          "isCameraEnabled": true,
          "isLibraryEnabled": true
        }
      ]
    ],
    extra: {
      eas: {
        projectId: "75628a9b-2245-43c7-88cb-71ba91bc8c1c"
      },
      apiUrl,
      useLocal: useLocal,
      apiUrlRemote: env.API_URL_REMOTE || 'http://13.126.205.202:4000',
      apiUrlLocal: env.API_URL_LOCAL || 'http://192.168.29.103:4000'
    }
  }
};
