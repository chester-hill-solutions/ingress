"""Optional local inference for the checkout experiment. No provider context or credentials.

Run in an isolated environment with sentence-transformers>=6.1.0 and transformers.
Weights/cache live in artifacts by default. The arbiter itself uses only Node built-ins.
"""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8766)
parser.add_argument('--cache', default='artifacts/checkout-embeddinggemma-cache')
parser.add_argument('--revision', default='914f7f89142e33e77833254d9c9b90c3cef7303b')
args = parser.parse_args()
cache = str(Path(args.cache).resolve())
os.environ['HF_HOME'] = cache
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

from sentence_transformers import SentenceTransformer
import torch

MODEL_ID = 'google/embeddinggemma-2'
model = SentenceTransformer(MODEL_ID, revision=args.revision, cache_folder=cache, device='cpu',
    config_kwargs={'vision_config': None, 'audio_config': None},
    model_kwargs={'torch_dtype': torch.float32})
metadata = {'model': MODEL_ID, 'modelRevision': args.revision,
    'encoders': 'text/code only', 'dimensions': 768, 'device': 'cpu', 'precision': 'float32'}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, value):
        data = json.dumps(value, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200 if self.path == '/health' else 404, metadata if self.path == '/health' else {'error': 'not_found'})

    def do_POST(self):
        if self.path != '/embed':
            return self.reply(404, {'error': 'not_found'})
        if self.headers.get('Origin') is not None or self.headers.get('Content-Type') != 'application/json':
            return self.reply(403, {'error': 'local_json_client_required'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 2 * 1024 * 1024:
                return self.reply(413, {'error': 'batch_too_large'})
            body = json.loads(self.rfile.read(size))
            texts, prompt = body['texts'], body['prompt']
            if prompt not in ('Document', 'CodeRetrieval') or not isinstance(texts, list) or not 1 <= len(texts) <= 256:
                raise ValueError('invalid batch')
            if any(not isinstance(text, str) or len(text) > 32768 for text in texts):
                raise ValueError('invalid text')
            if any(len(model.tokenizer.encode(text)) + 32 > 8192 for text in texts):
                return self.reply(413, {'error': 'input_would_be_truncated'})
            # Document strings already carry the title/filename prefix.
            options = {} if prompt == 'Document' else {'prompt_name': prompt}
            vectors = model.encode(texts, batch_size=8, normalize_embeddings=True,
                show_progress_bar=False, **options).tolist()
            self.reply(200, {**metadata, 'embeddings': vectors})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': 'invalid_batch'})
        except Exception:
            self.reply(500, {'error': 'inference_failed'})

print(json.dumps({'ready': True, 'url': f'http://127.0.0.1:{args.port}', **metadata}), flush=True)
HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
