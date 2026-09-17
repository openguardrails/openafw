//! Mask latency on mixed corpora — compare with AIRS's regex tier numbers
//! (16 KB ≈ 9 ms, 4 MB ≈ 643 ms under V8/RE2). Run: cargo run --release -p afw-engine --example bench
use std::time::Instant;

use afw_engine::{builtin_ruleset, compile, mask, SessionMap, DEFAULT_TIERS};

fn corpus(target: usize) -> String {
    let fragments = [
        "Here is some ordinary prose about deploying the service to the cluster and rotating credentials.\n",
        "export DB_URL=postgres://app:Storewave@2022@db.internal:5432/app\n",
        "curl -H \"Authorization: Bearer pk_cc7f7b3f73664638b8f30fe8ca598848\" https://api.example.com/v1/x\n",
        "const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });\n",
        "password = changeme\nusername: alice\napi_key: <YOUR_KEY>\n",
        "AKIAIOSFODNN7EXAMPLE was rotated; the new one is in the vault.\n",
        "{\"tool_use_id\":\"toolu_01\",\"content\":\"total 48\\ndrwxr-xr-x  12 tom  staff   384 Sep 13 19:58 .\\n\"}\n",
        "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij is a github token shape; sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 an openai one.\n",
        "日志：连接超时，重试三次后放弃。用户邮箱 alice@example.com，电话 13800138000。\n",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AZ\n-----END RSA PRIVATE KEY-----\n",
    ];
    let mut s = String::with_capacity(target + 512);
    let mut i = 0;
    while s.len() < target {
        s.push_str(fragments[i % fragments.len()]);
        i += 1;
    }
    s
}

fn main() {
    let rs = builtin_ruleset();
    let compiled = compile(&rs, DEFAULT_TIERS);
    assert!(compiled.disabled.is_empty());
    for &size in &[16 * 1024, 200 * 1024, 1024 * 1024, 4 * 1024 * 1024] {
        let text = corpus(size);
        // warm
        let _ = mask(&text, &mut SessionMap::new(), Some(&compiled));
        let runs = if size >= 1024 * 1024 { 3 } else { 10 };
        let mut best = f64::MAX;
        let mut minted = 0;
        for _ in 0..runs {
            let mut map = SessionMap::new();
            let t = Instant::now();
            let r = mask(&text, &mut map, Some(&compiled));
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
            minted = r.minted.len();
        }
        println!("{:>7} KB  best {:>8.2} ms  ({} distinct secrets minted)", size / 1024, best, minted);
    }
    // A resent history: the same leaves, turn after turn, through the cache.
    {
        let text = corpus(200 * 1024);
        let leaves: Vec<String> = text.split_inclusive('\n').collect::<Vec<_>>().chunks(40).map(|c| c.concat()).collect();
        let mut map = SessionMap::new();
        let mut cache = afw_engine::MaskCache::new(64 << 20);
        let t = Instant::now();
        for l in &leaves { let _ = afw_engine::mask_cached(l, &mut map, Some(&compiled), &mut cache); }
        let first = t.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        for l in &leaves { let _ = afw_engine::mask_cached(l, &mut map, Some(&compiled), &mut cache); }
        let second = t.elapsed().as_secs_f64() * 1000.0;
        println!("--- 200 KB as {} leaves: first turn {:.2} ms, resent turn {:.2} ms (hits {}, misses {})", leaves.len(), first, second, cache.hits, cache.misses);
    }
    // per-rule cost on the 200 KB corpus
    let text = corpus(200 * 1024);
    println!("--- per rule, 200 KB ---");
    for rule in &compiled.rules {
        let t = Instant::now();
        let n = afw_engine::ruleset::rule_spans(rule, &text).len();
        println!("{:<28} {:>8.2} ms  {} spans", rule.id, t.elapsed().as_secs_f64() * 1000.0, n);
    }
}
