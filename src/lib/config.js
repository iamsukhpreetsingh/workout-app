import Constants from 'expo-constants';

const getApiUrl = () => {
  const envUrl = Constants.expoConfig?.extra?.apiUrl;
  if (envUrl) return envUrl;
  
  const useLocal = Constants.expoConfig?.extra?.useLocal === true;
  const remoteUrl = Constants.expoConfig?.extra?.apiUrlRemote || 'http://13.126.205.202:4000';
  const localUrl = Constants.expoConfig?.extra?.apiUrlLocal || 'http://192.168.29.103:4000';
  
  return useLocal ? localUrl : remoteUrl;
};

const API_URL = getApiUrl();
console.log('[CONFIG] API_URL:', API_URL);

export { API_URL };
