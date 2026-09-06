Pod::Spec.new do |s|
  s.name           = 'JarvisAudio'
  s.version        = '1.0.0'
  s.summary        = 'Incremental PCM playback for Jarvis.'
  s.description    = 'Bounded, cancellable PCM playback.'
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
