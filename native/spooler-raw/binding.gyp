{
  "targets": [
    {
      "target_name": "spooler_raw",
      "sources": ["spooler_raw.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["winspool.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": { "ExceptionHandling": 1 }
            }
          }
        ]
      ]
    }
  ]
}
