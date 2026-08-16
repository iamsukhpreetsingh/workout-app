import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useColors } from '../theme';

// Shared header-right actions: settings + profile, identical sizing and
// spacing on every screen that registers them.
export default function HeaderActions({ navigation: navOverride, extra }) {
  const colors = useColors();
  const nav = navOverride || useNavigation();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <TouchableOpacity onPress={() => nav.navigate('Settings')} style={{ padding: 8 }}>
        <Ionicons name="settings-outline" size={22} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity onPress={() => nav.navigate('Profile')} style={{ padding: 8 }}>
        <Ionicons name="person-circle-outline" size={22} color={colors.text} />
      </TouchableOpacity>
      {extra}
    </View>
  );
}

// Registers this pair as a screen's headerRight (call from useLayoutEffect)
export function useHeaderActions(navigation, deps = []) {
  const colors = useColors();
  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <HeaderActions navigation={navigation} />,
    });
  }, [navigation, colors, ...deps]);
}
