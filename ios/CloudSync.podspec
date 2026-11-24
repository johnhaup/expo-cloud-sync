Pod::Spec.new do |s|
  s.name           = 'CloudSync'
  s.version        = '0.3.0'
  s.summary        = 'Record sync for expo-sqlite apps through the CloudKit private database'
  s.homepage       = 'https://github.com/johnhaup/expo-cloud-sync'
  s.license        = 'UNLICENSED'
  s.author         = 'John Haupenthal'
  s.source         = { git: 'https://github.com/johnhaup/expo-cloud-sync.git' }
  s.platform       = :ios, '17.0'
  s.swift_version  = '5.9'
  s.source_files   = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CloudKit'
end
