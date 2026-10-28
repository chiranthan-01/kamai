import { Link } from 'expo-router'
import { View, Text } from 'react-native'

export default function NotFoundScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: '#0F0F0F', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontSize: 18, marginBottom: 16 }}>Screen not found</Text>
      <Link href="/" style={{ color: '#10B981' }}>Go home</Link>
    </View>
  )
}