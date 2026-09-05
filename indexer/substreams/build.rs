use anyhow::{Ok, Result};
use substreams_ethereum::Abigen;

// Generates strongly-typed event decoders from abi/aqua.json into
// src/abi/aqua.rs at build time (substreams-ethereum Abigen).
fn main() -> Result<()> {
    Abigen::new("Aqua", "abi/aqua.json")?
        .generate()?
        .write_to_file("src/abi/aqua.rs")?;

    Ok(())
}
