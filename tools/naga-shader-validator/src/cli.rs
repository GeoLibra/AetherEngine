use std::path::PathBuf;

/// A local cook invocation. The filesystem path is deliberately kept outside
/// the serializable cooker protocol so it cannot leak into artifact metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CookCommand {
    pub input_path: PathBuf,
    pub source_uri: String,
}

/// A parsed native-tool command. Legacy arguments remain opaque so their
/// established parsing and error ordering stay unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Cook(CookCommand),
    Legacy(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CookArgumentError {
    InvalidArguments,
    InvalidSourceUri,
}

pub fn parse_command(args: Vec<String>) -> Result<Command, CookArgumentError> {
    if args.first().map(String::as_str) != Some("cook") {
        return Ok(Command::Legacy(args));
    }

    if args.len() != 4 || args[2] != "--source-uri" {
        return Err(CookArgumentError::InvalidArguments);
    }

    let source_uri = args[3].clone();
    if !is_valid_source_uri(&source_uri) {
        return Err(CookArgumentError::InvalidSourceUri);
    }

    Ok(Command::Cook(CookCommand {
        input_path: PathBuf::from(&args[1]),
        source_uri,
    }))
}

fn is_valid_source_uri(source_uri: &str) -> bool {
    let path = source_uri
        .strip_prefix("asset://")
        .or_else(|| source_uri.strip_prefix("package://"));
    let Some(path) = path else {
        return false;
    };

    !path.is_empty()
        && !path.contains(['\\', '?', '#', '%'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}
