/**
 * FileTypeIcon Configuration
 *
 * Icon imports and mappings for file type detection.
 * Extracted from component to keep UI code minimal.
 */
// ============================================
// SVG Icon Imports
// ============================================
import AndroidIcon from "@src/assets/fileTypeIcons/android.svg";
import AngularIcon from "@src/assets/fileTypeIcons/angular.svg";
import ApplescriptIcon from "@src/assets/fileTypeIcons/applescript.svg";
import ArduinoIcon from "@src/assets/fileTypeIcons/arduino.svg";
import AssemblyIcon from "@src/assets/fileTypeIcons/assembly.svg";
import AstroIcon from "@src/assets/fileTypeIcons/astro.svg";
import AudioIcon from "@src/assets/fileTypeIcons/audio.svg";
import BabelIcon from "@src/assets/fileTypeIcons/babel.svg";
import CIcon from "@src/assets/fileTypeIcons/c.svg";
import ClojureIcon from "@src/assets/fileTypeIcons/clojure.svg";
import CmakeIcon from "@src/assets/fileTypeIcons/cmake.svg";
import CobolIcon from "@src/assets/fileTypeIcons/cobol.svg";
import CoffeeIcon from "@src/assets/fileTypeIcons/coffee.svg";
import CommandIcon from "@src/assets/fileTypeIcons/command.svg";
import CppIcon from "@src/assets/fileTypeIcons/cpp.svg";
import CrystalIcon from "@src/assets/fileTypeIcons/crystal.svg";
import CsharpIcon from "@src/assets/fileTypeIcons/csharp.svg";
import CssIcon from "@src/assets/fileTypeIcons/css.svg";
import CucumberIcon from "@src/assets/fileTypeIcons/cucumber.svg";
import CudaIcon from "@src/assets/fileTypeIcons/cuda.svg";
import CypressIcon from "@src/assets/fileTypeIcons/cypress.svg";
import DIcon from "@src/assets/fileTypeIcons/d.svg";
import DartIcon from "@src/assets/fileTypeIcons/dart.svg";
import DatabaseIcon from "@src/assets/fileTypeIcons/database.svg";
import DiffIcon from "@src/assets/fileTypeIcons/diff.svg";
import DjangoIcon from "@src/assets/fileTypeIcons/django.svg";
import DockerIcon from "@src/assets/fileTypeIcons/docker.svg";
import DocumentIcon from "@src/assets/fileTypeIcons/document.svg";
import EditorConfigIcon from "@src/assets/fileTypeIcons/editorconfig.svg";
import EjsIcon from "@src/assets/fileTypeIcons/ejs.svg";
import ElixirIcon from "@src/assets/fileTypeIcons/elixir.svg";
import ElmIcon from "@src/assets/fileTypeIcons/elm.svg";
import ErlangIcon from "@src/assets/fileTypeIcons/erlang.svg";
import EsbuildIcon from "@src/assets/fileTypeIcons/esbuild.svg";
import EslintIcon from "@src/assets/fileTypeIcons/eslint.svg";
import ExcelIcon from "@src/assets/fileTypeIcons/excel.svg";
import ExeIcon from "@src/assets/fileTypeIcons/exe.svg";
import FigmaIcon from "@src/assets/fileTypeIcons/figma.svg";
import FirebaseIcon from "@src/assets/fileTypeIcons/firebase.svg";
import FolderBaseIcon from "@src/assets/fileTypeIcons/folder-base.svg";
import FontIcon from "@src/assets/fileTypeIcons/font.svg";
import FortranIcon from "@src/assets/fileTypeIcons/fortran.svg";
import FsharpIcon from "@src/assets/fileTypeIcons/fsharp.svg";
import GatsbyIcon from "@src/assets/fileTypeIcons/gatsby.svg";
import GitIcon from "@src/assets/fileTypeIcons/git.svg";
import GoIcon from "@src/assets/fileTypeIcons/go.svg";
import GradleIcon from "@src/assets/fileTypeIcons/gradle.svg";
import GraphqlIcon from "@src/assets/fileTypeIcons/graphql.svg";
import GroovyIcon from "@src/assets/fileTypeIcons/groovy.svg";
import GruntIcon from "@src/assets/fileTypeIcons/grunt.svg";
import GulpIcon from "@src/assets/fileTypeIcons/gulp.svg";
import HIcon from "@src/assets/fileTypeIcons/h.svg";
import HamlIcon from "@src/assets/fileTypeIcons/haml.svg";
import HandlebarsIcon from "@src/assets/fileTypeIcons/handlebars.svg";
import HaskellIcon from "@src/assets/fileTypeIcons/haskell.svg";
import HaxeIcon from "@src/assets/fileTypeIcons/haxe.svg";
import HelmIcon from "@src/assets/fileTypeIcons/helm.svg";
import HppIcon from "@src/assets/fileTypeIcons/hpp.svg";
import HtmlIcon from "@src/assets/fileTypeIcons/html.svg";
import HttpIcon from "@src/assets/fileTypeIcons/http.svg";
import ImageIcon from "@src/assets/fileTypeIcons/image.svg";
import JavaIcon from "@src/assets/fileTypeIcons/java.svg";
import JsIcon from "@src/assets/fileTypeIcons/javascript.svg";
import JestIcon from "@src/assets/fileTypeIcons/jest.svg";
import JinjaIcon from "@src/assets/fileTypeIcons/jinja.svg";
import JsonIcon from "@src/assets/fileTypeIcons/json.svg";
import JuliaIcon from "@src/assets/fileTypeIcons/julia.svg";
import JupyterIcon from "@src/assets/fileTypeIcons/jupyter.svg";
import KeyIcon from "@src/assets/fileTypeIcons/key.svg";
import KotlinIcon from "@src/assets/fileTypeIcons/kotlin.svg";
import KubernetesIcon from "@src/assets/fileTypeIcons/kubernetes.svg";
import LessIcon from "@src/assets/fileTypeIcons/less.svg";
import LispIcon from "@src/assets/fileTypeIcons/lisp.svg";
import LockIcon from "@src/assets/fileTypeIcons/lock.svg";
import LogIcon from "@src/assets/fileTypeIcons/log.svg";
import LuaIcon from "@src/assets/fileTypeIcons/lua.svg";
import MakefileIcon from "@src/assets/fileTypeIcons/makefile.svg";
import MarkdownIcon from "@src/assets/fileTypeIcons/markdown.svg";
import MatlabIcon from "@src/assets/fileTypeIcons/matlab.svg";
import MavenIcon from "@src/assets/fileTypeIcons/maven.svg";
import MdxIcon from "@src/assets/fileTypeIcons/mdx.svg";
import NginxIcon from "@src/assets/fileTypeIcons/nginx.svg";
import NimIcon from "@src/assets/fileTypeIcons/nim.svg";
import NixIcon from "@src/assets/fileTypeIcons/nix.svg";
import NpmIcon from "@src/assets/fileTypeIcons/npm.svg";
import NuxtIcon from "@src/assets/fileTypeIcons/nuxt.svg";
import ObjectiveCIcon from "@src/assets/fileTypeIcons/objective-c.svg";
import OcamlIcon from "@src/assets/fileTypeIcons/ocaml.svg";
import PdfIcon from "@src/assets/fileTypeIcons/pdf.svg";
import PerlIcon from "@src/assets/fileTypeIcons/perl.svg";
import PhpIcon from "@src/assets/fileTypeIcons/php.svg";
import PlaywrightIcon from "@src/assets/fileTypeIcons/playwright.svg";
import PnpmIcon from "@src/assets/fileTypeIcons/pnpm.svg";
import PostcssIcon from "@src/assets/fileTypeIcons/postcss.svg";
import PowerpointIcon from "@src/assets/fileTypeIcons/powerpoint.svg";
import PowershellIcon from "@src/assets/fileTypeIcons/powershell.svg";
import PrettierIcon from "@src/assets/fileTypeIcons/prettier.svg";
import PrismaIcon from "@src/assets/fileTypeIcons/prisma.svg";
import PrologIcon from "@src/assets/fileTypeIcons/prolog.svg";
import ProtoIcon from "@src/assets/fileTypeIcons/proto.svg";
import PugIcon from "@src/assets/fileTypeIcons/pug.svg";
import PurescriptIcon from "@src/assets/fileTypeIcons/purescript.svg";
import PythonIcon from "@src/assets/fileTypeIcons/python.svg";
import RIcon from "@src/assets/fileTypeIcons/r.svg";
import RacketIcon from "@src/assets/fileTypeIcons/racket.svg";
import RcIcon from "@src/assets/fileTypeIcons/rc.svg";
import ReactIcon from "@src/assets/fileTypeIcons/react.svg";
import ReactTsIcon from "@src/assets/fileTypeIcons/react_ts.svg";
import ReadmeIcon from "@src/assets/fileTypeIcons/readme.svg";
import ReasonIcon from "@src/assets/fileTypeIcons/reason.svg";
import RubyIcon from "@src/assets/fileTypeIcons/ruby.svg";
import RustIcon from "@src/assets/fileTypeIcons/rust.svg";
import SassIcon from "@src/assets/fileTypeIcons/sass.svg";
import ScalaIcon from "@src/assets/fileTypeIcons/scala.svg";
import SchemeIcon from "@src/assets/fileTypeIcons/scheme.svg";
import ConfigIcon from "@src/assets/fileTypeIcons/settings.svg";
import SolidityIcon from "@src/assets/fileTypeIcons/solidity.svg";
import SqlIcon from "@src/assets/fileTypeIcons/sql.svg";
import StorybookIcon from "@src/assets/fileTypeIcons/storybook.svg";
import StylelintIcon from "@src/assets/fileTypeIcons/stylelint.svg";
import StylusIcon from "@src/assets/fileTypeIcons/stylus.svg";
import SvelteIcon from "@src/assets/fileTypeIcons/svelte.svg";
import SvgIcon from "@src/assets/fileTypeIcons/svg.svg";
import SvgrIcon from "@src/assets/fileTypeIcons/svgr.svg";
import SwaggerIcon from "@src/assets/fileTypeIcons/swagger.svg";
import SwiftIcon from "@src/assets/fileTypeIcons/swift.svg";
import TailwindIcon from "@src/assets/fileTypeIcons/tailwindcss.svg";
import TauriIcon from "@src/assets/fileTypeIcons/tauri.svg";
import TerraformIcon from "@src/assets/fileTypeIcons/terraform.svg";
import TestJsIcon from "@src/assets/fileTypeIcons/test-js.svg";
import TestTsIcon from "@src/assets/fileTypeIcons/test-ts.svg";
import TexIcon from "@src/assets/fileTypeIcons/tex.svg";
import TwigIcon from "@src/assets/fileTypeIcons/twig.svg";
import TsDefIcon from "@src/assets/fileTypeIcons/typescript-def.svg";
import TsIcon from "@src/assets/fileTypeIcons/typescript.svg";
import ValaIcon from "@src/assets/fileTypeIcons/vala.svg";
import VercelIcon from "@src/assets/fileTypeIcons/vercel.svg";
import VerilogIcon from "@src/assets/fileTypeIcons/verilog.svg";
import VideoIcon from "@src/assets/fileTypeIcons/video.svg";
import VimIcon from "@src/assets/fileTypeIcons/vim.svg";
import ViteIcon from "@src/assets/fileTypeIcons/vite.svg";
import VitestIcon from "@src/assets/fileTypeIcons/vitest.svg";
import VlangIcon from "@src/assets/fileTypeIcons/vlang.svg";
import VueIcon from "@src/assets/fileTypeIcons/vue.svg";
import WasmIcon from "@src/assets/fileTypeIcons/webassembly.svg";
import WebpackIcon from "@src/assets/fileTypeIcons/webpack.svg";
import WordIcon from "@src/assets/fileTypeIcons/word.svg";
import XmlIcon from "@src/assets/fileTypeIcons/xml.svg";
import YamlIcon from "@src/assets/fileTypeIcons/yaml.svg";
import YarnIcon from "@src/assets/fileTypeIcons/yarn.svg";
import ZigIcon from "@src/assets/fileTypeIcons/zig.svg";
import ZipIcon from "@src/assets/fileTypeIcons/zip.svg";

import type { FileType } from "./types";

// ============================================
// Default/Fallback Icon Export
// ============================================

export { DocumentIcon };

// ============================================
// Icon Map
// ============================================

/** Maps file types to their corresponding SVG icon components */
export const ICON_MAP: Record<
  FileType,
  React.FC<React.SVGProps<SVGSVGElement>>
> = {
  python: PythonIcon,
  javascript: JsIcon,
  typescript: TsIcon,
  "typescript-def": TsDefIcon,
  markdown: MarkdownIcon,
  mdx: MdxIcon,
  json: JsonIcon,
  html: HtmlIcon,
  css: CssIcon,
  scss: SassIcon,
  sass: SassIcon,
  less: LessIcon,
  stylus: StylusIcon,
  postcss: PostcssIcon,
  jsx: ReactIcon,
  tsx: ReactTsIcon,
  java: JavaIcon,
  kotlin: KotlinIcon,
  scala: ScalaIcon,
  groovy: GroovyIcon,
  c: CIcon,
  cpp: CppIcon,
  h: HIcon,
  hpp: HppIcon,
  csharp: CsharpIcon,
  fsharp: FsharpIcon,
  go: GoIcon,
  rust: RustIcon,
  php: PhpIcon,
  ruby: RubyIcon,
  shell: CommandIcon,
  powershell: PowershellIcon,
  yaml: YamlIcon,
  xml: XmlIcon,
  sql: SqlIcon,
  swift: SwiftIcon,
  vue: VueIcon,
  svelte: SvelteIcon,
  react: ReactIcon,
  "react-ts": ReactTsIcon,
  angular: AngularIcon,
  test: TestJsIcon,
  "test-ts": TestTsIcon,
  config: ConfigIcon,
  rc: RcIcon,
  docker: DockerIcon,
  git: GitIcon,
  lua: LuaIcon,
  perl: PerlIcon,
  r: RIcon,
  julia: JuliaIcon,
  jupyter: JupyterIcon,
  dart: DartIcon,
  elixir: ElixirIcon,
  erlang: ErlangIcon,
  haskell: HaskellIcon,
  clojure: ClojureIcon,
  lisp: LispIcon,
  scheme: SchemeIcon,
  racket: RacketIcon,
  ocaml: OcamlIcon,
  reason: ReasonIcon,
  purescript: PurescriptIcon,
  elm: ElmIcon,
  nim: NimIcon,
  zig: ZigIcon,
  crystal: CrystalIcon,
  d: DIcon,
  fortran: FortranIcon,
  cobol: CobolIcon,
  assembly: AssemblyIcon,
  wasm: WasmIcon,
  solidity: SolidityIcon,
  graphql: GraphqlIcon,
  proto: ProtoIcon,
  terraform: TerraformIcon,
  hcl: TerraformIcon,
  nginx: NginxIcon,
  cmake: CmakeIcon,
  makefile: MakefileIcon,
  gradle: GradleIcon,
  maven: MavenIcon,
  npm: NpmIcon,
  pnpm: PnpmIcon,
  yarn: YarnIcon,
  eslint: EslintIcon,
  prettier: PrettierIcon,
  stylelint: StylelintIcon,
  babel: BabelIcon,
  webpack: WebpackIcon,
  vite: ViteIcon,
  vitest: VitestIcon,
  jest: JestIcon,
  cypress: CypressIcon,
  playwright: PlaywrightIcon,
  storybook: StorybookIcon,
  prisma: PrismaIcon,
  tailwind: TailwindIcon,
  svg: SvgIcon,
  svgr: SvgrIcon,
  image: ImageIcon,
  video: VideoIcon,
  audio: AudioIcon,
  font: FontIcon,
  folder: FolderBaseIcon,
  pdf: PdfIcon,
  word: WordIcon,
  excel: ExcelIcon,
  document: DocumentIcon,
  powerpoint: PowerpointIcon,
  "pages-doc": WordIcon,
  zip: ZipIcon,
  lock: LockIcon,
  log: LogIcon,
  env: ConfigIcon,
  key: KeyIcon,
  readme: ReadmeIcon,
  license: DocumentIcon,
  android: AndroidIcon,
  kubernetes: KubernetesIcon,
  helm: HelmIcon,
  firebase: FirebaseIcon,
  vercel: VercelIcon,
  tauri: TauriIcon,
  nuxt: NuxtIcon,
  gatsby: GatsbyIcon,
  nix: NixIcon,
  vim: VimIcon,
  tex: TexIcon,
  prolog: PrologIcon,
  matlab: MatlabIcon,
  "objective-c": ObjectiveCIcon,
  verilog: VerilogIcon,
  vala: ValaIcon,
  vlang: VlangIcon,
  haml: HamlIcon,
  pug: PugIcon,
  ejs: EjsIcon,
  jinja: JinjaIcon,
  twig: TwigIcon,
  handlebars: HandlebarsIcon,
  haxe: HaxeIcon,
  arduino: ArduinoIcon,
  cuda: CudaIcon,
  toml: ConfigIcon,
  editorconfig: EditorConfigIcon,
  http: HttpIcon,
  swagger: SwaggerIcon,
  astro: AstroIcon,
  applescript: ApplescriptIcon,
  coffee: CoffeeIcon,
  django: DjangoIcon,
  database: DatabaseIcon,
  diff: DiffIcon,
  exe: ExeIcon,
  figma: FigmaIcon,
  grunt: GruntIcon,
  gulp: GulpIcon,
  cucumber: CucumberIcon,
  esbuild: EsbuildIcon,
  other: DocumentIcon,
};
