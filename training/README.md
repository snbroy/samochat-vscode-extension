# Optional SaMo model fine-tuning

This directory contains an experimental GPU LoRA/QLoRA starter, not a trained model and not part of the VS Code extension runtime. The small seed set only smoke-tests the data pipeline; it is not sufficient to establish meaningful model improvements.

## Hosted NVIDIA inference is not model training

The SaMo portal currently calls an OpenAI-compatible hosted inference endpoint. Sending prompts to that endpoint does not update model weights. This training workflow downloads an open-weight model and fine-tunes it on a compatible CUDA GPU. Serving a resulting adapter requires a runtime compatible with that base model and adapter; this does not automatically change the model configured on Railway.

## Requirements and setup

Use Linux, Python 3.10 or 3.11, an NVIDIA GPU, and CUDA-compatible PyTorch. Install PyTorch separately using the official PyTorch selector for the installed driver, then install `training/requirements.txt`. Verify that PyTorch detects the GPU before training. Check the selected model's license, access requirements, chat template, architecture, VRAM needs, and commercial-use terms.

The default model is `Qwen/Qwen2.5-Coder-7B-Instruct`; 4-bit adapter tuning can still require substantial VRAM and compatibility work. The scripts are starter utilities, not universal trainers.

## Dataset format and privacy

Each JSONL row contains a `messages` array with `system`, `user`, and `assistant` roles. Each record must include at least one user and assistant message. Use only examples you have permission to train on. Remove credentials, personal data, customer information, and private source code that you cannot use. Expand the seed set with carefully reviewed examples and keep evaluation prompts held out from training.

## Pipeline

```sh
python training/scripts/prepare_dataset.py \
  --input training/samo-seed.jsonl \
  --output-dir training/data \
  --train-ratio 0.8 --validation-ratio 0.1 --test-ratio 0.1

python training/scripts/train_lora.py \
  --model-id Qwen/Qwen2.5-Coder-7B-Instruct \
  --train-file training/data/train.jsonl \
  --validation-file training/data/validation.jsonl \
  --output-dir training/output/samo-qwen-coder-lora \
  --epochs 3 --max-length 2048 --load-in-4bit

python training/scripts/run_eval.py \
  --model-id Qwen/Qwen2.5-Coder-7B-Instruct \
  --prompts training/evaluation-prompts.json \
  --output training/output/baseline-eval.json \
  --load-in-4bit

python training/scripts/run_eval.py \
  --model-id Qwen/Qwen2.5-Coder-7B-Instruct \
  --adapter-dir training/output/samo-qwen-coder-lora/adapter \
  --prompts training/evaluation-prompts.json \
  --output training/output/tuned-eval.json \
  --load-in-4bit
```

Review base and adapter results blindly on an expanded held-out set. Evaluate correctness, instruction following, security, honesty, and naturalness separately; severe safety or truthfulness failures must not be hidden by an average score. Run engineering tests on generated code. Pin model, adapter, tokenizer, dataset, prompt, and decoding revisions before deployment, and retain a rollback path.

The extension uses repository and workspace context for changing project facts. Fine-tuning is for stable behavior patterns, not a replacement for current documentation or user-specific context. Nothing in this directory claims that SaMo has been trained.
