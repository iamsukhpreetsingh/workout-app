// Backend base URL for production APK
const FALLBACK_URL = 'http://13.126.205.202:4000';

let API_URL = FALLBACK_URL;

// Try to get from expo constants or env
try {
  const Constants = require('expo-constants').Constants;
  if (Constants?.expoConfig?.extra?.apiUrl) {
    API_URL = Constants.expoConfig.extra.apiUrl;
  }
} catch (e) {
  // fallback to process.env or default
  if (process.env.EXPO_PUBLIC_API_URL) {
    API_URL = process.env.EXPO_PUBLIC_API_URL;
  }
}

export { API_URL };
