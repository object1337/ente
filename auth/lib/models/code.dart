import 'package:ente_auth/utils/totp_util.dart';

class Code {
  static const defaultDigits = 6;
  static const steamDigits = 5;
  static const defaultPeriod = 30;

  int? generatedID;
  final String account;
  final String issuer;
  final int digits;
  final int period;
  final String secret;
  final Algorithm algorithm;
  final Type type;
  final String rawData;
  final int counter;
  bool? hasSynced;

  Code(
    this.account,
    this.issuer,
    this.digits,
    this.period,
    this.secret,
    this.algorithm,
    this.type,
    this.counter,
    this.rawData, {
    this.generatedID,
  });

  Code copyWith({
    String? account,
    String? issuer,
    int? digits,
    int? period,
    String? secret,
    Algorithm? algorithm,
    Type? type,
    int? counter,
  }) {
    final String updateAccount = account ?? this.account;
    final String updateIssuer = issuer ?? this.issuer;
    final int updatedDigits = digits ?? this.digits;
    final int updatePeriod = period ?? this.period;
    final String updatedSecret = secret ?? this.secret;
    final Algorithm updatedAlgo = algorithm ?? this.algorithm;
    final Type updatedType = type ?? this.type;
    final int updatedCounter = counter ?? this.counter;

    return Code(
      updateAccount,
      updateIssuer,
      updatedDigits,
      updatePeriod,
      updatedSecret,
      updatedAlgo,
      updatedType,
      updatedCounter,
      "otpauth://${updatedType.name}/$updateIssuer:$updateAccount?algorithm=${updatedAlgo.name}"
      "&digits=$updatedDigits&issuer=$updateIssuer"
      "&period=$updatePeriod&secret=$updatedSecret${updatedType == Type.hotp ? "&counter=$updatedCounter" : ""}",
      generatedID: generatedID,
    );
  }

  static Code fromAccountAndSecret(
    Type type,
    String account,
    String issuer,
    String secret,
    int digits,
  ) {
    return Code(
      account,
      issuer,
      digits,
      defaultPeriod,
      secret,
      Algorithm.sha1,
      type,
      0,
      "otpauth://${type.name}/$issuer:$account?algorithm=SHA1&digits=$digits&issuer=$issuer&period=30&secret=$secret",
    );
  }

  static Code fromRawData(String rawData) {
    Uri uri = Uri.parse(rawData);
    final issuer = _getIssuer(uri);

    try {
      return Code(
        _getAccount(uri),
        issuer,
        _getDigits(uri, issuer),
        _getPeriod(uri),
        getSanitizedSecret(uri.queryParameters['secret']!),
        _getAlgorithm(uri),
        _getType(uri),
        _getCounter(uri),
        rawData,
      );
    } catch (e) {
      // if account name contains # without encoding,
      // rest of the url are treated as url fragment
      if (rawData.contains("#")) {
        return Code.fromRawData(rawData.replaceAll("#", '%23'));
      } else {
        rethrow;
      }
    }
  }

  static String _getAccount(Uri uri) {
    try {
      String path = Uri.decodeComponent(uri.path);
      if (path.startsWith("/")) {
        path = path.substring(1, path.length);
      }
      // Parse account name from documented auth URI
      // otpauth://totp/ACCOUNT?secret=SUPERSECRET&issuer=SERVICE
      if (uri.queryParameters.containsKey("issuer") && !path.contains(":")) {
        return path;
      }
      return path.split(':')[1];
    } catch (e) {
      return "";
    }
  }

  static String _getIssuer(Uri uri) {
    try {
      if (uri.queryParameters.containsKey("issuer")) {
        String issuerName = uri.queryParameters['issuer']!;
        // Handle issuer name with period
        // See https://github.com/ente-io/ente/pull/77
        if (issuerName.contains("period=")) {
          return issuerName.substring(0, issuerName.indexOf("period="));
        }
        return issuerName;
      }
      final String path = Uri.decodeComponent(uri.path);
      return path.split(':')[0].substring(1);
    } catch (e) {
      return "";
    }
  }

  static int _getDigits(Uri uri, String issuer) {
    try {
      return int.parse(uri.queryParameters['digits']!);
    } catch (e) {
      if (issuer.toLowerCase() == "steam") {
        return steamDigits;
      }
      return defaultDigits;
    }
  }

  static int _getPeriod(Uri uri) {
    try {
      return int.parse(uri.queryParameters['period']!);
    } catch (e) {
      return defaultPeriod;
    }
  }

  static int _getCounter(Uri uri) {
    try {
      final bool hasCounterKey = uri.queryParameters.containsKey('counter');
      if (!hasCounterKey) {
        return 0;
      }
      return int.parse(uri.queryParameters['counter']!);
    } catch (e) {
      return defaultPeriod;
    }
  }

  static Algorithm _getAlgorithm(Uri uri) {
    try {
      final algorithm =
          uri.queryParameters['algorithm'].toString().toLowerCase();
      if (algorithm == "sha256") {
        return Algorithm.sha256;
      } else if (algorithm == "sha512") {
        return Algorithm.sha512;
      }
    } catch (e) {
      // nothing
    }
    return Algorithm.sha1;
  }

  static Type _getType(Uri uri) {
    if (uri.host == "totp") {
      return Type.totp;
    } else if (uri.host == "steam") {
      return Type.steam;
    } else if (uri.host == "hotp") {
      return Type.hotp;
    }
    throw UnsupportedError("Unsupported format with host ${uri.host}");
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;

    return other is Code &&
        other.account == account &&
        other.issuer == issuer &&
        other.digits == digits &&
        other.period == period &&
        other.secret == secret &&
        other.counter == counter &&
        other.type == type &&
        other.rawData == rawData;
  }

  @override
  int get hashCode {
    return account.hashCode ^
        issuer.hashCode ^
        digits.hashCode ^
        period.hashCode ^
        secret.hashCode ^
        type.hashCode ^
        counter.hashCode ^
        rawData.hashCode;
  }
}

enum Type {
  totp,
  hotp,
  steam;

  bool get isTOTPCompatible => this == totp || this == steam;
}

enum Algorithm {
  sha1,
  sha256,
  sha512,
}
