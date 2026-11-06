$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
# Fixed helper source only: request fields are never interpolated into executable code.
$helperSource = @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;
public static class DshRemoteFiles {
  public const string Consistency = "Metadata tokens detect ordinary edits, not same-length edits with restored timestamps. Replacement hashes before/after streaming; noncooperating writers can race the final check and commit.";
  static Exception Fail(string code, string message) { return new IOException(code + ": " + message); }
  public static string Version(string path) {
    var f = new FileInfo(path); if (!f.Exists) throw Fail("NOT_FOUND", "File does not exist");
    return "meta-v1:" + f.Length + ":" + f.LastWriteTimeUtc.Ticks + ":" + f.CreationTimeUtc.Ticks;
  }
  public static string Hash(string path) {
    using (var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
    using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
  }
  public static Encoding EncodingFor(string name) {
    switch ((String.IsNullOrEmpty(name) ? "utf8" : name).ToLowerInvariant().Replace("-", "")) {
      case "utf8": return new UTF8Encoding(false, true);
      case "utf16le": return new UnicodeEncoding(false, false, true);
      case "utf16be": return new UnicodeEncoding(true, false, true);
      default: throw Fail("ENCODING", "Only utf8, utf16le and utf16be are supported");
    }
  }
  public sealed class TextFile : IDisposable {
    public FileStream Stream; public StreamReader Reader; public Encoding Encoding; public string Name; public byte[] Preamble;
    public TextFile(string path, string requested) {
      Stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
      try {
        byte[] b = new byte[4]; int n = Stream.Read(b, 0, 4), skip = 0; string detected = null;
        if(n>=4 && ((b[0]==255 && b[1]==254 && b[2]==0 && b[3]==0)||(b[0]==0 && b[1]==0 && b[2]==254 && b[3]==255))) throw Fail("ENCODING", "UTF32 is unsupported");
        if(n>=3 && b[0]==239 && b[1]==187 && b[2]==191){detected="utf8";skip=3;}
        else if(n>=2 && b[0]==255 && b[1]==254){detected="utf16le";skip=2;}
        else if(n>=2 && b[0]==254 && b[1]==255){detected="utf16be";skip=2;}
        string normalized = (requested ?? "").ToLowerInvariant().Replace("-", "");
        if(detected!=null && normalized!="" && detected!=normalized) throw Fail("ENCODING", "Explicit encoding conflicts with BOM");
        Name=detected ?? (normalized=="" ? "utf8" : normalized); Encoding=EncodingFor(Name);
        Preamble=new byte[skip]; Array.Copy(b,Preamble,skip); Stream.Position=skip;
        Reader=new StreamReader(Stream,Encoding,false,4096,true);
      } catch { Stream.Dispose(); throw; }
    }
    public void Dispose(){if(Reader!=null)Reader.Dispose();Stream.Dispose();}
  }
  public static Dictionary<string,object> Info(string path) {
    return new Dictionary<string,object>{{"ok",true},{"path",path},{"bytes",new FileInfo(path).Length},{"version",Version(path)},{"versionKind","metadata-v1"},{"consistency",Consistency}};
  }
  public static object Read(string path,string encoding,int maxBytes) {
    if(new FileInfo(path).Length>maxBytes)throw Fail("FILE_TOO_LARGE","Use readlines for this file");
    string v=Version(path); using(var t=new TextFile(path,encoding)) {
      var r=Info(path);r["content"]=t.Reader.ReadToEnd();r["encoding"]=t.Name;r["bom"]=t.Preamble.Length>0;
      if(Version(path)!=v)throw Fail("VERSION_CONFLICT","File changed while reading");return r;
    }
  }
  // Uses scalar-sized reads, never ReadLine: memory remains bounded even for a multi-GB line.
  static string Scalar(StreamReader r) {
    int c=r.Read(); if(c<0)return null;
    if(Char.IsHighSurrogate((char)c)){int d=r.Read();if(d<0 || !Char.IsLowSurrogate((char)d))throw Fail("ENCODING","Invalid surrogate");return new string(new char[]{(char)c,(char)d});}
    return new string((char)c,1);
  }
  public static object Lines(string path,string encoding,long offset,long column,int limit,int maxBytes,string expected) {
    string v=Version(path);if(!String.IsNullOrEmpty(expected) && expected!=v)throw Fail("VERSION_CONFLICT","File changed since previous page");
    using(var t=new TextFile(path,encoding)) {
      var lines=new List<object>();long line=1,col=0;int used=0;bool partial=false; string s;
      while(line<offset && (s=Scalar(t.Reader))!=null){if(s=="\r"){if(t.Reader.Peek()==10)t.Reader.Read();line++;}else if(s=="\n")line++;}
      while(line==offset && col<column && t.Reader.Peek()>=0){s=Scalar(t.Reader);if(s=="\r"||s=="\n")throw Fail("INVALID_ARGUMENT","column is beyond this line");col++;}
      if(col!=column)throw Fail("INVALID_ARGUMENT","column is beyond this line");
      while(line>=offset && lines.Count<limit && t.Reader.Peek()>=0){
        var text=new StringBuilder();long start=col;string newline="";bool truncated=false;
        while(t.Reader.Peek()>=0){
          int peek=t.Reader.Peek();
          if(peek==13||peek==10){t.Reader.Read();newline=peek==13?"\r":"\n";if(peek==13 && t.Reader.Peek()==10){t.Reader.Read();newline="\r\n";}break;}
          // Maximum scalar size is four UTF8 bytes; inspect without consuming if budget cannot fit.
          int need=peek<128?1:(peek<2048?2:(Char.IsHighSurrogate((char)peek)?4:3));
          if(used+need>maxBytes){truncated=true;break;}
          s=Scalar(t.Reader);text.Append(s);used+=need;col++;
        }
        lines.Add(new Dictionary<string,object>{{"number",line},{"column",start},{"text",text.ToString()},{"newline",newline},{"truncated",truncated}});
        if(truncated){partial=true;break;}line++;col=0;
      }
      if(Version(path)!=v)throw Fail("VERSION_CONFLICT","File changed while reading");
      var r=Info(path);r["lines"]=lines;r["nextOffset"]=line;r["nextColumn"]=col;r["hasMore"]=t.Reader.Peek()>=0;r["truncated"]=partial;r["encoding"]=t.Name;r["bom"]=t.Preamble.Length>0;r["textBytes"]=used;return r;
    }
  }
  static string Temp(string path){return Path.Combine(Path.GetDirectoryName(Path.GetFullPath(path)),".dsh-"+Guid.NewGuid().ToString("N")+".tmp");}
  static void Commit(string temp,string path,bool overwrite){
    if(File.Exists(path)){if(!overwrite)throw Fail("ALREADY_EXISTS","Explicit overwrite required");File.Replace(temp,path,null);}
    else File.Move(temp,path);
  }
  public static object Write(string path,string content,string encoding,bool bom,bool overwrite) {
    var enc=EncodingFor(encoding);byte[] payload=enc.GetBytes(content);byte[] pre=new byte[0];
    if(bom){if(enc is UTF8Encoding)pre=new byte[]{239,187,191};else pre=enc.CodePage==1201?new byte[]{254,255}:new byte[]{255,254};}
    return Put(path,payload,pre,overwrite,null);
  }
  public static object Put(string path,byte[] payload,byte[] pre,bool overwrite,string expectedHash) {
    if(File.Exists(path)&&!overwrite)throw Fail("ALREADY_EXISTS","Explicit overwrite required");
    string temp=Temp(path);try {
      using(var f=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.Write(pre,0,pre.Length);f.Write(payload,0,payload.Length);f.Flush(true);}
      string hash=Hash(temp);if(!String.IsNullOrEmpty(expectedHash)&&!String.Equals(hash,expectedHash,StringComparison.OrdinalIgnoreCase))throw Fail("HASH_MISMATCH","Upload SHA256 mismatch");
      Commit(temp,path,overwrite);var r=Info(path);r["sha256"]=hash;return r;
    }finally{if(File.Exists(temp))File.Delete(temp);}
  }
  public static object Download(string path,int maxBytes) {
    if(new FileInfo(path).Length>maxBytes)throw Fail("FILE_TOO_LARGE","Download exceeds transfer cap");
    string v=Version(path);byte[] data=File.ReadAllBytes(path);string hash;
    using(var h=SHA256.Create())hash=BitConverter.ToString(h.ComputeHash(data)).Replace("-", "").ToLowerInvariant();
    if(Version(path)!=v)throw Fail("VERSION_CONFLICT","File changed during download");
    var r=Info(path);r["dataBase64"]=Convert.ToBase64String(data);r["sha256"]=hash;return r;
  }
  public static object Replace(string path,string oldText,string newText,bool all,long expectedCount,string expectedVersion,string encoding) {
    if(String.IsNullOrEmpty(expectedVersion))throw Fail("INVALID_ARGUMENT","expectedVersion is mandatory");
    if(String.IsNullOrEmpty(oldText))throw Fail("INVALID_ARGUMENT","oldString cannot be empty");
    string before=Version(path);if(before!=expectedVersion)throw Fail("VERSION_CONFLICT","File changed since read");
    string beforeHash=Hash(path);if(Version(path)!=before)throw Fail("VERSION_CONFLICT","File changed while hashing");
    string temp=Temp(path);long count=0;string encName="";bool hasBom=false;
    try {
      using(var t=new TextFile(path,encoding))
      using(var output=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
        encName=t.Name;hasBom=t.Preamble.Length>0;output.Write(t.Preamble,0,t.Preamble.Length);
        using(var writer=new StreamWriter(output,t.Encoding,4096,true)) {
          // Retain oldText.Length-1 chars across buffers. Matches consume nonoverlapping literals.
          char[] buffer=new char[4096];string pending="";int n;
          while((n=t.Reader.Read(buffer,0,buffer.Length))>0){
            pending+=new string(buffer,0,n);int pos=0,index;
            while((index=pending.IndexOf(oldText,pos,StringComparison.Ordinal))>=0){writer.Write(pending.Substring(pos,index-pos));writer.Write(newText);count++;pos=index+oldText.Length;}
            int safe=Math.Max(pos,pending.Length-oldText.Length+1);
            // Do not split a surrogate pair when flushing the unmatched tail.
            if(safe>pos && safe<pending.Length && Char.IsHighSurrogate(pending[safe-1]))safe--;
            writer.Write(pending.Substring(pos,safe-pos));pending=pending.Substring(safe);
          }
          writer.Write(pending);writer.Flush();
        } output.Flush(true);
      }
      if(count==0)throw Fail("NO_MATCH","No literal matches");
      if(!all && count!=1)throw Fail("MULTIPLE_MATCHES","Default replacement requires exactly one match");
      if(expectedCount>=0 && count!=expectedCount)throw Fail("COUNT_MISMATCH","Literal match count differs from expectedCount");
      if(Version(path)!=before || Hash(path)!=beforeHash || Version(path)!=before)throw Fail("VERSION_CONFLICT","File changed before commit");
      long oldBytes=new FileInfo(path).Length,newBytes=new FileInfo(temp).Length;string afterHash=Hash(temp);
      Commit(temp,path,true);var r=Info(path);r["count"]=count;r["beforeVersion"]=before;r["afterVersion"]=r["version"];r["beforeSha256"]=beforeHash;r["sha256"]=afterHash;r["bytesBefore"]=oldBytes;r["bytesAfter"]=newBytes;r["modifiedBytes"]=count*(EncodingFor(encName).GetByteCount(oldText)+EncodingFor(encName).GetByteCount(newText));r["encoding"]=encName;r["bom"]=hasBom;return r;
    }finally{if(File.Exists(temp))File.Delete(temp);}
  }
}
'@
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($requestBase64)) | ConvertFrom-Json -AsHashtable
  $a = $request.args
  if ($request.operation -eq 'status') {
    $result = @{ ok = $true; hostname = [Environment]::MachineName; powershellVersion = $PSVersionTable.PSVersion.ToString(); platform = [Environment]::OSVersion.ToString() }
  } else {
    if (-not ('DshRemoteFiles' -as [type])) { Add-Type -TypeDefinition $helperSource }
    if ($a.path -isnot [string] -or [string]::IsNullOrWhiteSpace($a.path)) { throw 'INVALID_ARGUMENT: path is required' }
    $path = [IO.Path]::GetFullPath($a.path)
    $encoding = $null
    if ($a.ContainsKey('encoding')) { $encoding = [string]$a.encoding }
    $maxBytes = 1048576
    if ($a.ContainsKey('maxBytes')) { $maxBytes = [int]$a.maxBytes }
    if ($maxBytes -lt 1 -or $maxBytes -gt 16777216) { throw 'INVALID_ARGUMENT: maxBytes must be 1..16777216' }
    if ($request.operation -eq 'readlines' -and $maxBytes -lt 4) { throw 'INVALID_ARGUMENT: readlines maxBytes must be at least 4' }
    switch ($request.operation) {
      'stat' { $result = [DshRemoteFiles]::Info($path) }
      'read' { $result = [DshRemoteFiles]::Read($path,$encoding,$maxBytes) }
      'readlines' {
        $offset = 1L; $column = 0L; $limit = 100
        if ($a.ContainsKey('offset')) { $offset = [long]$a.offset }
        if ($a.ContainsKey('column')) { $column = [long]$a.column }
        if ($a.ContainsKey('limit')) { $limit = [int]$a.limit }
        if ($offset -lt 1 -or $column -lt 0 -or $limit -lt 1 -or $limit -gt 10000) { throw 'INVALID_ARGUMENT: invalid page bounds' }
        $expected = $null; if ($a.ContainsKey('expectedVersion')) { $expected = [string]$a.expectedVersion }
        $result = [DshRemoteFiles]::Lines($path,$encoding,$offset,$column,$limit,$maxBytes,$expected)
      }
      'write' {
        if ($a.content -isnot [string]) { throw 'INVALID_ARGUMENT: content must be a string' }
        $result = [DshRemoteFiles]::Write($path,$a.content,$encoding,($a.bom -eq $true),($a.overwrite -eq $true))
      }
      'replace' {
        if ($a.oldString -isnot [string] -or $a.newString -isnot [string]) { throw 'INVALID_ARGUMENT: oldString and newString must be strings' }
        $count = -1L
        if ($a.ContainsKey('expectedCount')) { $count = [long]$a.expectedCount; if ($count -lt 0) { throw 'INVALID_ARGUMENT: expectedCount must be nonnegative' } }
        $result = [DshRemoteFiles]::Replace($path,$a.oldString,$a.newString,($a.all -eq $true),$count,[string]$a.expectedVersion,$encoding)
      }
      'upload' {
        if ($a.dataBase64 -isnot [string] -or $a.dataBase64.Length -gt 22369624) { throw 'INVALID_ARGUMENT: upload requires base64 data within 16 MiB' }
        $hash = $null; if ($a.ContainsKey('sha256')) { $hash = [string]$a.sha256 }
        $result = [DshRemoteFiles]::Put($path,[Convert]::FromBase64String($a.dataBase64),[byte[]]::new(0),($a.overwrite -eq $true),$hash)
      }
      'download' { $result = [DshRemoteFiles]::Download($path,$maxBytes) }
      default { throw 'INVALID_ARGUMENT: unsupported operation' }
    }
  }
  $result | ConvertTo-Json -Depth 12 -Compress
} catch {
  $message = $_.Exception.Message
  $code = 'IO_ERROR'
  if ($message -match '([A-Z_]+): ([^\r\n]*)') { $code = $Matches[1]; $message = $Matches[2] }
  if ($_.Exception.ToString() -match 'DecoderFallbackException|EncoderFallbackException') { $code = 'ENCODING' }
  @{ ok = $false; error = @{ code = $code; message = $message } } | ConvertTo-Json -Compress
}
