import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'model_server.dart';

// Serves the viewer + picked files over http://localhost so ES modules + model fetch work.
final modelServer = ModelServer();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await modelServer.start();
  runApp(const MaterialApp(debugShowCheckedModeBanner: false, home: VrmPage()));
}

class VrmPage extends StatefulWidget {
  const VrmPage({super.key});

  @override
  State<VrmPage> createState() => _VrmPageState();
}

class _VrmPageState extends State<VrmPage> {
  InAppWebViewController? _web;
  Key _webKey = UniqueKey(); // replaced to recreate the WebView after its renderer dies
  bool _loaded = false;
  bool _loading = true;
  String _title = 'Loading…';
  List<String> _actions = [];
  List<String> _expressions = [];
  final Map<String, double> _weights = {};
  String _action = 'idle';
  List<String> _bundled = []; // paths relative to assets/web, e.g. models/Seed-san.vrm
  bool _autoBlink = true, _lipSync = false, _lookAt = true;

  @override
  void initState() {
    super.initState();
    AssetManifest.loadFromAssetBundle(rootBundle).then((m) {
      const prefix = 'assets/web/';
      setState(() => _bundled = m
          .listAssets()
          .where((a) => a.startsWith('${prefix}models/') && (a.endsWith('.vrm') || a.endsWith('.glb')))
          .map((a) => a.substring(prefix.length))
          .toList()
        ..sort());
    });
  }

  Future<void> _loadModel(String url) async {
    setState(() {
      _loading = true;
      _title = 'Loading…';
      _weights.clear();
      _action = 'idle';
    });
    await _js("loadModel(${jsonEncode(url)})");
  }

  Future<void> _pickModel() async {
    // .vrm has no registered MIME type on Android, so allow any file and check the extension.
    final files = await FilePicker.pickFiles(type: FileType.any);
    final path = files.isEmpty ? null : files.single.path;
    if (path == null) return;
    if (!path.toLowerCase().endsWith('.vrm') && !path.toLowerCase().endsWith('.glb')) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Please choose a .vrm or .glb file')));
      }
      return;
    }
    await _loadModel(modelServer.addFile(path));
  }

  Future<void> _js(String code) async => _web?.evaluateJavascript(source: 'window.vrmApi.$code');

  void _onMessage(List<dynamic> args) {
    final msg = jsonDecode(args.first as String) as Map<String, dynamic>;
    setState(() {
      if (msg['type'] == 'loaded') {
        final data = msg['data'] as Map<String, dynamic>;
        final meta = data['meta'] as Map<String, dynamic>;
        final author = meta['author'] ?? (meta['authors'] as List?)?.join(', ') ?? '?';
        _title = '${data['name']} (VRM ${data['version']}) · $author';
        _actions = List<String>.from(data['actions']);
        _expressions = List<String>.from(data['expressions']);
        _action = data['version'] == 'glTF' ? '' : 'idle';
        _loaded = true;
        _loading = false;
      } else if (msg['type'] == 'error') {
        _title = 'Error: ${msg['data']}';
        _loading = false;
      } else if (msg['type'] == 'action') {
        _action = msg['data'] as String; // viewer switched action on its own (e.g. bow -> idle)
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_title, style: const TextStyle(fontSize: 15)), actions: [
        PopupMenuButton<String>(
          tooltip: 'Bundled models',
          icon: const Icon(Icons.people),
          onSelected: _loadModel,
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'model.vrm', child: Text('Default (Test)')),
            for (final m in _bundled)
              PopupMenuItem(
                value: m,
                child: Text('${m.endsWith('.glb') ? '🎞' : '🧍'} ${m.split('/').last.replaceAll(RegExp(r'\.(vrm|glb)$'), '')}'),
              ),
          ],
        ),
        IconButton(tooltip: 'Open .vrm file', icon: const Icon(Icons.folder_open), onPressed: _pickModel),
        IconButton(tooltip: 'Default model', icon: const Icon(Icons.restore), onPressed: () => _loadModel('model.vrm')),
        IconButton(icon: const Icon(Icons.center_focus_strong), onPressed: () => _js('resetCamera()')),
      ]),
      body: Column(children: [
        Expanded(
          flex: 3,
          child: InAppWebView(
            key: _webKey,
            initialUrlRequest: URLRequest(url: WebUri('${modelServer.baseUrl}/index.html')),
            initialSettings: InAppWebViewSettings(transparentBackground: true, mediaPlaybackRequiresUserGesture: false),
            onWebViewCreated: (c) {
              _web = c;
              c.addJavaScriptHandler(handlerName: 'vrm', callback: _onMessage);
            },
            onConsoleMessage: (_, m) => debugPrint('[web] ${m.message}'),
            // Unhandled, a killed renderer (e.g. low memory) takes the whole app down with it.
            // The dead WebView can't be reused, so build a new one; it reloads the default model.
            onRenderProcessGone: (_, detail) {
              debugPrint('WebView renderer gone (crash: ${detail.didCrash}), recreating');
              setState(() {
                _web = null;
                _webKey = UniqueKey();
                _loaded = false;
                _loading = true;
                _title = 'Loading…';
              });
            },
          ),
        ),
        if (_loading) const LinearProgressIndicator(),
        if (_loaded) Expanded(flex: 2, child: _controls()),
      ]),
    );
  }

  Widget _controls() {
    return ListView(padding: const EdgeInsets.all(12), children: [
      const Text('Actions', style: TextStyle(fontWeight: FontWeight.bold)),
      Wrap(spacing: 6, children: [
        for (final a in _actions)
          ChoiceChip(
            label: Text(a),
            selected: _action == a,
            onSelected: (_) {
              setState(() => _action = a);
              _js("playAction('$a')");
            },
          ),
      ]),
      SwitchListTile(dense: true, title: const Text('Auto blink'), value: _autoBlink, onChanged: (v) {
        setState(() => _autoBlink = v);
        _js('setAutoBlink($v)');
      }),
      SwitchListTile(dense: true, title: const Text('Lip sync (A-I-U-E-O loop)'), value: _lipSync, onChanged: (v) {
        setState(() => _lipSync = v);
        _js('setLipSync($v)');
      }),
      SwitchListTile(dense: true, title: const Text('Eyes follow camera'), value: _lookAt, onChanged: (v) {
        setState(() => _lookAt = v);
        _js('setLookAt($v)');
      }),
      Row(children: [
        const Text('Expressions', style: TextStyle(fontWeight: FontWeight.bold)),
        const Spacer(),
        TextButton(
          onPressed: () {
            setState(_weights.clear);
            _js('resetExpressions()');
          },
          child: const Text('Reset'),
        ),
      ]),
      for (final e in _expressions)
        Row(children: [
          SizedBox(width: 90, child: Text(e)),
          Expanded(
            child: Slider(
              value: _weights[e] ?? 0,
              onChanged: (v) {
                setState(() => _weights[e] = v);
                _js("setExpression('$e', $v)");
              },
            ),
          ),
        ]),
    ]);
  }
}
