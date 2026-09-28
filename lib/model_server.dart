import 'dart:io';

import 'package:flutter/services.dart';

/// Local HTTP server for the WebView: serves the viewer from `assets/web/`
/// and any user-picked .vrm file from disk under `/picked/<id>/<name>`.
class ModelServer {
  ModelServer({this.port = 8089});

  final int port;
  HttpServer? _server;
  final Map<String, String> _picked = {}; // id -> absolute file path
  int _nextId = 0;

  String get baseUrl => 'http://localhost:$port';

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, port, shared: true);
    _server!.listen(_handle);
  }

  /// Registers a local file and returns the URL the viewer can load it from.
  String addFile(String path) {
    final id = '${_nextId++}';
    _picked[id] = path;
    return '/picked/$id/${Uri.encodeComponent(path.split(Platform.pathSeparator).last)}';
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    final segments = req.uri.pathSegments;
    try {
      if (segments.length >= 2 && segments.first == 'picked') {
        final path = _picked[segments[1]];
        if (path == null) return _notFound(res);
        final file = File(path);
        res.headers
          ..contentType = ContentType.binary
          ..contentLength = await file.length();
        await res.addStream(file.openRead());
      } else {
        final name = segments.isEmpty ? 'index.html' : segments.join('/');
        final data = await rootBundle.load('assets/web/$name');
        res.headers.contentType =
            name.endsWith('.html') ? ContentType.html : ContentType.binary;
        res.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      }
    } catch (_) {
      return _notFound(res);
    }
    await res.close();
  }

  Future<void> _notFound(HttpResponse res) async {
    res.statusCode = HttpStatus.notFound;
    await res.close();
  }
}
