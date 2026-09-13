Pod::Spec.new do |s|
  s.name           = 'CirceLocalAsr'
  s.version        = '1.0.0'
  s.summary        = 'On-device speech availability probe for Circe.'
  s.description    = 'iOS stub. Real transcription uses Apple SpeechAnalyzer through @react-native-ai/apple.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
