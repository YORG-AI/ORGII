#!/usr/bin/env python3
"""
orgii_banana2_generate.py - 调用 ZenMux Vertex AI 图像生成/编辑 (E8 迁移)

迁移自 OpenClaw scripts/banana2_generate.py。ORG-2 版去掉内嵌明文 key，
key 优先级: 函数参数 > env ZENMUX_API_KEY > credentials.json(zenmux-tiygate)。

用法:
  python3 orgii_banana2_generate.py <input_image> <prompt> [output_path]
  python3 orgii_banana2_generate.py --text-only <prompt> [output_path]

端点: https://zenmux.ai/api/vertex-ai/v1/publishers/{provider}/models/{model}:generateContent
模型: google/gemini-3.1-flash-image-preview (alias: banana2)

env:
  ZENMUX_API_KEY    直连 Vertex AI 用的 ZenMux key
  ORGII_CREDENTIALS credentials.json 路径（兜底取 key）
"""
import requests
import json
import base64
import sys
import os
import argparse

BASE_URL = "https://zenmux.ai/api/vertex-ai"
PROVIDER = "google"
MODEL = "gemini-3.1-flash-image-preview"
DEFAULT_CREDS = os.environ.get(
    "ORGII_CREDENTIALS",
    "/home/hy/clawd/projects/orgii-data/credentials.json",
)


def _key_from_creds():
    try:
        d = json.load(open(DEFAULT_CREDS))
        return d.get("credentials", {}).get("zenmux-tiygate", {}).get("api_key", "")
    except Exception:
        return ""


def resolve_key(api_key=None):
    return api_key or os.environ.get("ZENMUX_API_KEY") or _key_from_creds()


def generate(prompt, image_path=None, output_path=None, api_key=None, temperature=0.4):
    key = resolve_key(api_key)
    if not key:
        print("❌ 无 ZenMux key（设 ZENMUX_API_KEY 或 credentials.json zenmux-tiygate.api_key）",
              file=sys.stderr)
        sys.exit(2)
    url = f"{BASE_URL}/v1/publishers/{PROVIDER}/models/{MODEL}:generateContent"
    
    parts = [{"text": prompt}]
    if image_path:
        with open(image_path, 'rb') as f:
            img_b64 = base64.b64encode(f.read()).decode('utf-8')
        mime = 'image/png' if image_path.endswith('.png') else 'image/jpeg'
        parts.append({"inlineData": {"mimeType": mime, "data": img_b64}})
    
    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "temperature": temperature
        }
    }
    
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    
    print(f"🔄 Calling banana2...")
    resp = requests.post(url, headers=headers, json=payload, timeout=180)
    
    if resp.status_code != 200:
        print(f"❌ Status {resp.status_code}: {resp.text[:300]}")
        return None
    
    result = resp.json()
    images = []
    texts = []
    
    for candidate in result.get('candidates', []):
        for part in candidate.get('content', {}).get('parts', []):
            if 'inlineData' in part:
                img_bytes = base64.b64decode(part['inlineData']['data'])
                mime = part['inlineData'].get('mimeType', 'image/png')
                ext = 'png' if 'png' in mime else 'jpg'
                if not output_path:
                    output_path = f'banana2_output.{ext}'
                with open(output_path, 'wb') as f:
                    f.write(img_bytes)
                print(f"✅ Saved: {output_path} ({len(img_bytes)//1024}KB)")
                images.append(output_path)
            elif 'text' in part:
                texts.append(part['text'])
    
    if not images:
        print("⚠️ No image in response")
        if texts:
            print(f"Text: {texts[0][:200]}")
    
    return images[0] if images else None

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='banana2 image generation')
    parser.add_argument('input', help='Input image path or --text-only')
    parser.add_argument('prompt', help='Prompt text')
    parser.add_argument('output', nargs='?', default=None, help='Output path')
    parser.add_argument('--temperature', type=float, default=0.4)
    args = parser.parse_args()
    
    img = None if args.input == '--text-only' else args.input
    generate(args.prompt, img, args.output, temperature=args.temperature)
